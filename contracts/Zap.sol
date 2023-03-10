// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./libraries/Math.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IWETH.sol";

contract Zap is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANT VARIABLES ========== */

    address public immutable WETH;
    IUniswapV2Router02 public immutable ROUTER;
    IUniswapV2Factory public immutable FACTORY;
    uint256 public lastFetchedPairIndex;
    /* ========== STATE VARIABLES ========== */

    mapping(address => bool) public liquidityPools;

    mapping(address => uint256) public tokens;
    address[] public tokenList;

    mapping(address => uint256) public intermediateTokens;
    address[] public intermediateTokenList;

    mapping(address => mapping(address => address[])) public presetPaths;

    /* ========== EVENT ========== */
    event ZapIn(address indexed to, uint256 amount, uint256 outputAmount);
    event ZapInToken(address indexed from, address indexed to, uint256 amount, uint256 outputAmount);
    event ZapOut(address indexed from, address indexed to, uint256 amount, uint256 outputAmount);
    event SwapExactTokensForTokens(address[] paths, uint256[] amounts);
    event FetchLiquidityPoolsFromFactory(uint256 startFromPairIndex, uint256 endAtPairIndex);

    event AddLiquidityPool(address indexed liquidityPool, bool isFromFactory);
    event AddToken(address indexed token, bool isFromFactory);
    event AddIntermediateToken(address indexed intermediateToken);

    event RemoveLiquidityPool(address indexed liquidityPool);
    event RemoveToken(address indexed token);
    event RemoveIntermediateToken(address indexed intermediateToken);

    event SetPresetPath(address indexed fromToken, address indexed toToken, address[] paths, bool isAutoGenerated);
    event RemovePresetPath(address indexed fromToken, address indexed toToken);

    /* ========== INITIALIZER ========== */

    constructor(address _weth, address _router) {
        WETH = _weth;
        ROUTER = IUniswapV2Router02(_router);
        FACTORY = IUniswapV2Factory(ROUTER.factory());
        _addToken(WETH, false);
        _addIntermediateToken(WETH);
    }

    receive() external payable {}

    /* ========== External Functions ========== */

    /// @notice swap ERC20 Token to ERC20 Token or LP
    function zapInToken(
        address _fromToken,
        uint256 _inputAmount,
        address _toTokenOrLp,
        uint256 _outputAmountMin
    ) external nonReentrant returns (uint256) {
        require(isToken(_fromToken), "Zap:zapInToken: given fromToken is not token");
        require(isToken(_toTokenOrLp) || isLP(_toTokenOrLp), "Zap:zapInToken: given toTokenOrLp is not token or LP");
        require(_inputAmount > 0, "Zap:zapInToken: given amount should > 0");
        IERC20(_fromToken).safeTransferFrom(msg.sender, address(this), _inputAmount);
        uint256 outputAmount = _zapInFromToken(_fromToken, _inputAmount, _toTokenOrLp, msg.sender);
        require(outputAmount >= _outputAmountMin, "Zap:zapInToken: output amount less than expected");
        emit ZapInToken(_fromToken, _toTokenOrLp, _inputAmount, outputAmount);
        return outputAmount;
    }

    /// @notice swap ETH to ERC20 Token or LP, ETH will wrap into WETH before the rest of action
    /// @param _outputAmountMin: minimum amount expected to received , can estimate by
    /// @return outputAmount: amount of target Token or LP which user will received
    /// @dev estimateZapInToLpSwapPaths if output is LP
    /// @dev estimateZapTokenToTokenAmountsOut if output is token
    function zapIn(address _toTokenOrLp, uint256 _outputAmountMin) external payable nonReentrant returns (uint256) {
        require(msg.value > 0, "Zap:zapIn: given amount should > 0");
        IWETH(WETH).deposit{value: msg.value}();
        require(isToken(_toTokenOrLp) || isLP(_toTokenOrLp), "Zap:zapIn: given toTokenOrLp is not token or LP");
        uint256 outputAmount = _zapInFromToken(WETH, msg.value, _toTokenOrLp, msg.sender);
        require(outputAmount >= _outputAmountMin, "Zap:zapIn: output amount less than expected");
        emit ZapIn(_toTokenOrLp, msg.value, outputAmount);
        return outputAmount;
    }

    /// @notice break LP into token , and swap to target Token or stake as another LP
    function zapOut(
        address _fromLp,
        uint256 _inputAmount,
        address _toTokenOrLp,
        uint256 _outputAmountMin
    ) external payable nonReentrant returns (uint256) {
        require(isLP(_fromLp), "Zap:zapOut: should zap out from LP Address");
        require(_fromLp != _toTokenOrLp, "Zap:zapOut: input = output");
        require(_inputAmount > 0, "Zap:zapOut: given amount should > 0");
        IERC20(_fromLp).safeTransferFrom(msg.sender, address(this), _inputAmount);
        _approveTokenIfNeeded(_fromLp);
        uint256 outputAmount;
        if (isLP(_toTokenOrLp)) {
            uint256 removedAmount = _removeLiquidityToToken(_fromLp, _inputAmount, WETH, address(this));
            outputAmount = _zapInFromToken(WETH, removedAmount, _toTokenOrLp, msg.sender);
        } else if (isToken(_toTokenOrLp)) {
            outputAmount = _removeLiquidityToToken(_fromLp, _inputAmount, _toTokenOrLp, msg.sender);
        } else if (_toTokenOrLp == address(0)) {
            // handle native ETH
            outputAmount = _removeLiquidityToToken(_fromLp, _inputAmount, WETH, address(this));
            IWETH(WETH).withdraw(outputAmount);
            (bool sent, ) = payable(msg.sender).call{value: outputAmount}("");
            require(sent, "Failed to send Ether");
        } else {
            revert("Zap:zapOut: should zap out to Token or LP Address");
        }

        require(outputAmount >= _outputAmountMin, "Zap:zapIn: output amount less than expected");
        emit ZapOut(_fromLp, _toTokenOrLp, _inputAmount, outputAmount);
        return outputAmount;
    }

    /* ========== View Functions ========== */

    function getLiquidityPoolAddress(address _tokenA, address _tokenB) public view returns (address) {
        return FACTORY.getPair(_tokenA, _tokenB);
    }

    function isLiquidityPoolExistInFactory(address _tokenA, address _tokenB) public view returns (bool) {
        return getLiquidityPoolAddress(_tokenA, _tokenB) != address(0);
    }

    function isLP(address _address) public view returns (bool) {
        return liquidityPools[_address] == true;
    }

    function isToken(address _address) public view returns (bool) {
        return !(tokens[_address] == 0);
    }

    function getToken(uint256 i) public view returns (address) {
        return tokenList[i];
    }

    function getTokenListLength() public view returns (uint256) {
        return tokenList.length;
    }

    function getIntermediateToken(uint256 _i) public view returns (address) {
        return intermediateTokenList[_i];
    }

    function getIntermediateTokenListLength() public view returns (uint256) {
        return intermediateTokenList.length;
    }

    /// @notice For complicated / special target , can preset path for swapping for gas saving
    function getPresetPath(address _tokenA, address _tokenB) public view returns (address[] memory) {
        return presetPaths[_tokenA][_tokenB];
    }

    /// @notice For estimate zapIn (Token -> Token) path, including preset path & auto calculated path
    /// if preset path exist , preset path will be taken instead of auto calculated path
    function getPathForTokenToToken(address _fromToken, address _toToken) external view returns (address[] memory) {
        return _getPathForTokenToToken(_fromToken, _toToken);
    }

    /// @notice For checking zapIn (Token -> Token) AUTO-CALCULATED path , in order to allow estimate output amount
    /// fromToken -> IntermediateToken (if any) -> toToken
    function getAutoCalculatedPathWithIntermediateTokenForTokenToToken(
        address _fromToken,
        address _toToken
    ) external view returns (address[] memory) {
        return _autoCalculatedPathWithIntermediateTokenForTokenToToken(_fromToken, _toToken);
    }

    /// @notice  For estimate zapIn path , in order to allow estimate output amount
    /// fromToken -> IntermediateToken (if any) -> token 0 & token 1 in LP -> LP
    function getSuitableIntermediateTokenForTokenToLP(
        address _fromToken,
        address _toLP
    ) external view returns (address) {
        return _getSuitableIntermediateToken(_fromToken, _toLP);
    }

    /* ========== Update Functions ========== */

    /// @notice Open for public to call if when this contract's token & LP is outdated from factory
    /// only missing token and LP will be fetched according to lastFetchedPairIndex
    /// automatically fetch from last fetched index and with interval as 8
    function fetchLiquidityPoolsFromFactory() public {
        if (lastFetchedPairIndex < FACTORY.allPairsLength() - 1) {
            fetchLiquidityPoolsFromFactoryWithIndex(lastFetchedPairIndex, 8);
        }
    }

    /// @param _startFromPairIndex FACTORY.allPairs(i) 's index
    /// @param _interval number of LP going to be fetched starting from _startFromPairIndex
    function fetchLiquidityPoolsFromFactoryWithIndex(uint256 _startFromPairIndex, uint256 _interval) public {
        uint256 factoryPairLength = FACTORY.allPairsLength();
        require(
            _startFromPairIndex < factoryPairLength,
            "Zap:fetchLiquidityPoolsFromFactoryWithIndex: _startFromPairIndex should < factoryPairLength"
        );
        uint256 endAtPairIndex = _startFromPairIndex + _interval;
        if (endAtPairIndex > factoryPairLength) {
            endAtPairIndex = factoryPairLength;
        }
        for (uint256 i = _startFromPairIndex; i < endAtPairIndex; i++) {
            _addLiquidityPool(FACTORY.allPairs(i), true);
        }
        emit FetchLiquidityPoolsFromFactory(_startFromPairIndex, endAtPairIndex - 1);
        if (lastFetchedPairIndex < endAtPairIndex - 1) {
            lastFetchedPairIndex = endAtPairIndex - 1;
        }
    }

    /* ========== Private Functions ========== */

    function _removeLiquidityToToken(
        address _lp,
        uint256 _amount,
        address _toToken,
        address _receiver
    ) private returns (uint256) {
        require(isLP(_lp), "Zap:_removeLiquidityToToken: _lp is Non LP Address");
        IUniswapV2Pair pair = IUniswapV2Pair(_lp);
        address token0 = pair.token0();
        address token1 = pair.token1();
        (uint256 token0Amount, uint256 token1Amount) = ROUTER.removeLiquidity(
            token0,
            token1,
            _amount,
            0,
            0,
            address(this),
            block.timestamp
        );
        uint256 outputAmount = (
            (token0 == _toToken) ? token0Amount : _swapTokenToToken(token0, token0Amount, _toToken, address(this))
        ) + ((token1 == _toToken) ? token1Amount : _swapTokenToToken(token1, token1Amount, _toToken, address(this)));
        IERC20(_toToken).safeTransfer(_receiver, outputAmount);
        return outputAmount;
    }

    function _zapInFromToken(address _from, uint256 _amount, address _to, address _receiver) private returns (uint256) {
        _approveTokenIfNeeded(_from);
        if (isLP(_to)) {
            return _swapTokenToLP(_from, _amount, _to, _receiver);
        } else {
            return _swapTokenToToken(_from, _amount, _to, _receiver);
        }
    }

    function _approveTokenIfNeeded(address token) private {
        if (IERC20(token).allowance(address(this), address(ROUTER)) == 0) {
            IERC20(token).safeApprove(address(ROUTER), type(uint256).max);
        }
    }

    function _swapTokenToLP(
        address _fromToken,
        uint256 _fromTokenAmount,
        address _lp,
        address _receiver
    ) private returns (uint256) {
        require(isLP(_lp), "Zap:_swapTokenToLP: _lp is Non LP Address");
        (address token0, uint256 token0Amount, address token1, uint256 token1Amount) = _swapTokenToTokenPairForLP(
            _fromToken,
            _fromTokenAmount,
            _lp
        );
        _approveTokenIfNeeded(token0);
        _approveTokenIfNeeded(token1);
        return _addLiquidityAndReturnRemainingToUser(token0, token1, token0Amount, token1Amount, _receiver);
    }

    function _addLiquidityAndReturnRemainingToUser(
        address token0,
        address token1,
        uint256 token0Amount,
        uint256 token1Amount,
        address _receiver
    ) private returns (uint256) {
        (uint256 amountA, uint256 amountB, uint256 liquidity) = ROUTER.addLiquidity(
            token0,
            token1,
            token0Amount,
            token1Amount,
            0,
            0,
            _receiver,
            block.timestamp
        );
        if (token0Amount - amountA > 0) {
            IERC20(token0).transfer(_receiver, token0Amount - amountA);
        }
        if (token1Amount - amountB > 0) {
            IERC20(token1).transfer(_receiver, token1Amount - amountB);
        }
        return liquidity;
    }

    function _swapTokenToTokenPairForLP(
        address _fromToken,
        uint256 _fromTokenAmount,
        address _lp
    ) private returns (address, uint256, address, uint256) {
        IUniswapV2Pair pair = IUniswapV2Pair(_lp);
        address token0 = pair.token0();
        address token1 = pair.token1();
        uint256 token0Amount;
        uint256 token1Amount;
        if (_fromToken == token0) {
            token0Amount = _fromTokenAmount / 2;
            token1Amount = _swapTokenToToken(_fromToken, _fromTokenAmount - token0Amount, token1, address(this));
        } else if (_fromToken == token1) {
            token1Amount = _fromTokenAmount / 2;
            token0Amount = _swapTokenToToken(_fromToken, _fromTokenAmount - token1Amount, token0, address(this));
        } else {
            address intermediateToken = _getSuitableIntermediateToken(_fromToken, _lp);
            uint256 intermediateTokenAmount = _fromToken == intermediateToken
                ? _fromTokenAmount
                : _swapTokenToToken(_fromToken, _fromTokenAmount, intermediateToken, address(this));
            uint256 intermediateTokenAmountForToken0 = intermediateTokenAmount / 2;
            uint256 intermediateTokenAmountForToken1 = intermediateTokenAmount - intermediateTokenAmountForToken0;
            token0Amount = token0 == intermediateToken
                ? intermediateTokenAmountForToken0
                : _swapTokenToToken(intermediateToken, intermediateTokenAmountForToken0, token0, address(this));
            token1Amount = token1 == intermediateToken
                ? intermediateTokenAmountForToken1
                : _swapTokenToToken(intermediateToken, intermediateTokenAmountForToken1, token1, address(this));
        }
        return (token0, token0Amount, token1, token1Amount);
    }

    function _swapTokenToToken(
        address _fromToken,
        uint256 _fromAmount,
        address _toToken,
        address _receiver
    ) private returns (uint256) {
        address[] memory path = _getPathForTokenToToken(_fromToken, _toToken);
        _approveTokenIfNeeded(_fromToken);
        uint256[] memory amounts = ROUTER.swapExactTokensForTokens(_fromAmount, 0, path, _receiver, block.timestamp);
        require(amounts[amounts.length - 1] > 0, "Zap:_swapTokenToToken: output amounts invalid - 0 amoount");
        emit SwapExactTokensForTokens(path, amounts);
        return amounts[amounts.length - 1];
    }

    function _getPathForTokenToToken(address _fromToken, address _toToken) private view returns (address[] memory) {
        address[] memory path;
        require(_fromToken != _toToken, "Zap:_swapTokenToToken: Not Allow fromToken == toToken");
        if (isLiquidityPoolExistInFactory(_fromToken, _toToken)) {
            path = new address[](2);
            path[0] = _fromToken;
            path[1] = _toToken;
        } else {
            path = getPresetPath(_fromToken, _toToken);
            if (path.length == 0) {
                path = _autoCalculatedPathWithIntermediateTokenForTokenToToken(_fromToken, _toToken);
            }
        }
        require(path.length > 0, "Zap:_getPathForTokenToToken: Does not support this route");
        return path;
    }

    function _getSuitableIntermediateToken(address _fromToken, address _toLp) private view returns (address) {
        IUniswapV2Pair pair = IUniswapV2Pair(_toLp);
        address token0 = pair.token0();
        address token1 = pair.token1();
        // IntermediateToken is not necessary, returns _fromToken
        if (_fromToken == token0 || _fromToken == token1) {
            return _fromToken;
        }
        if (intermediateTokens[token0] > 0) {
            if (
                intermediateTokens[token1] > 0 &&
                !isLiquidityPoolExistInFactory(_fromToken, token0) &&
                isLiquidityPoolExistInFactory(_fromToken, token1)
            ) {
                // when both token0 & token1 can be intermediateToken, do comparison
                return token1;
            }
            return token0;
        }
        if (intermediateTokens[token1] > 0) {
            return token1;
        }
        if (
            intermediateTokens[_fromToken] > 0 &&
            isLiquidityPoolExistInFactory(_fromToken, token0) &&
            isLiquidityPoolExistInFactory(_fromToken, token1)
        ) {
            return _fromToken;
        }
        address bestIntermediateToken;
        for (uint256 i = 0; i < intermediateTokenList.length; i++) {
            address intermediateToken = intermediateTokenList[i];
            if (
                isLiquidityPoolExistInFactory(intermediateToken, token0) &&
                isLiquidityPoolExistInFactory(intermediateToken, token1)
            ) {
                if (isLiquidityPoolExistInFactory(_fromToken, intermediateToken)) {
                    return intermediateToken;
                }
                if (intermediateToken != address(0)) {
                    bestIntermediateToken = intermediateToken;
                }
            }
        }
        if (bestIntermediateToken != address(0)) {
            return bestIntermediateToken;
        }
        revert("Zap:_getSuitableIntermediateToken: Does not support this route");
    }

    function _autoCalculatedPathWithIntermediateTokenForTokenToToken(
        address _fromToken,
        address _toToken
    ) private view returns (address[] memory) {
        address[] memory path;
        for (uint256 i = 0; i < intermediateTokenList.length; i++) {
            address intermediateToken = intermediateTokenList[i];
            if (
                _fromToken != intermediateToken &&
                _toToken != intermediateToken &&
                isLiquidityPoolExistInFactory(_fromToken, intermediateToken) &&
                isLiquidityPoolExistInFactory(intermediateToken, _toToken)
            ) {
                path = new address[](3);
                path[0] = _fromToken;
                path[1] = intermediateToken;
                path[2] = _toToken;
                break;
            }
        }
        return path;
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function addToken(address _tokenAddress) external onlyOwner {
        require(tokens[_tokenAddress] == 0, "Zap:addToken: _tokenAddress is already in token list");
        _addToken(_tokenAddress, false);
    }

    function _addToken(address _tokenAddress, bool _isFromFactory) private {
        require(_tokenAddress != address(0), "Zap:_addToken: _tokenAddress should not be zero");
        require(isLP(_tokenAddress) == false, "Zap:_addToken: _tokenAddress is LP");
        tokenList.push(_tokenAddress);
        tokens[_tokenAddress] = tokenList.length;
        emit AddToken(_tokenAddress, _isFromFactory);
    }

    function removeToken(address _tokenAddress) external onlyOwner {
        uint256 tokenListIndex = tokens[_tokenAddress] - 1;
        delete tokens[_tokenAddress];
        if (tokenListIndex != tokenList.length - 1) {
            address lastTokenInList = tokenList[tokenList.length - 1];
            tokenList[tokenListIndex] = lastTokenInList;
            tokens[lastTokenInList] = tokenListIndex + 1;
        }
        tokenList.pop();
        emit RemoveToken(_tokenAddress);
    }

    function addIntermediateToken(address _tokenAddress) public onlyOwner {
        require(
            intermediateTokens[_tokenAddress] == 0,
            "Zap:addIntermediateToken: _tokenAddress is already in token list"
        );
        _addIntermediateToken(_tokenAddress);
    }

    function _addIntermediateToken(address _tokenAddress) private {
        require(_tokenAddress != address(0), "Zap:_addIntermediateToken: _tokenAddress should not be zero");
        require(isLP(_tokenAddress) == false, "Zap:_addIntermediateToken: _tokenAddress is LP");
        intermediateTokenList.push(_tokenAddress);
        intermediateTokens[_tokenAddress] = intermediateTokenList.length;
        emit AddIntermediateToken(_tokenAddress);
    }

    function removeIntermediateToken(address _intermediateTokenAddress) external onlyOwner {
        uint256 intermediateTokenListIndex = intermediateTokens[_intermediateTokenAddress] - 1;
        delete intermediateTokens[_intermediateTokenAddress];
        if (intermediateTokenListIndex != intermediateTokenList.length - 1) {
            address lastIntermediateTokenInList = intermediateTokenList[intermediateTokenList.length - 1];
            intermediateTokenList[intermediateTokenListIndex] = lastIntermediateTokenInList;
            intermediateTokens[lastIntermediateTokenInList] = intermediateTokenListIndex + 1;
        }
        intermediateTokenList.pop();
        emit RemoveIntermediateToken(_intermediateTokenAddress);
    }

    function setPresetPath(address _tokenA, address _tokenB, address[] memory _path) external onlyOwner {
        _setPresetPath(_tokenA, _tokenB, _path, false);
    }

    function setPresetPathByAutoCalculation(address _tokenA, address _tokenB) external onlyOwner {
        _setPresetPath(
            _tokenA,
            _tokenB,
            _autoCalculatedPathWithIntermediateTokenForTokenToToken(_tokenA, _tokenB),
            true
        );
    }

    function removePresetPath(address tokenA, address tokenB) external onlyOwner {
        delete presetPaths[tokenA][tokenB];
        emit RemovePresetPath(tokenA, tokenB);
    }

    function _setPresetPath(address _tokenA, address _tokenB, address[] memory _path, bool _isAutoGenerated) private {
        presetPaths[_tokenA][_tokenB] = _path;
        emit SetPresetPath(_tokenA, _tokenB, _path, _isAutoGenerated);
    }

    function addLiquidityPool(address _lpAddress) external onlyOwner {
        _addLiquidityPool(_lpAddress, false);
    }

    function removeLiquidityPool(address _lpAddress) external onlyOwner {
        liquidityPools[_lpAddress] = false;
        emit RemoveLiquidityPool(_lpAddress);
    }

    function _addLiquidityPool(address _lpAddress, bool _isFromFactory) private {
        require(_lpAddress != address(0), "Zap:_addLiquidityPool: _lpAddress should not be zero");
        if (!liquidityPools[_lpAddress]) {
            IUniswapV2Pair pair = IUniswapV2Pair(_lpAddress);
            address token0 = pair.token0();
            address token1 = pair.token1();
            if (!isToken(token0)) {
                _addToken(token0, true);
            }
            if (!isToken(token1)) {
                _addToken(token1, true);
            }
            liquidityPools[_lpAddress] = true;
            emit AddLiquidityPool(_lpAddress, _isFromFactory);
        }
    }

    /* ========== RESTRICTED FUNCTIONS FOR MISDEPOSIT ========== */

    function withdrawBalance(address _token, uint256 _amount) public payable onlyOwner {
        if (_token == address(0)) {
            uint256 balance = address(this).balance;
            if (balance > 0) {
                if (_amount == 0) {
                    (bool sent, ) = payable(msg.sender).call{value: balance}("");
                    require(sent, "Failed to send Ether");
                } else {
                    (bool sent, ) = payable(msg.sender).call{value: _amount}("");
                    require(sent, "Failed to send Ether");
                }
            }
        } else {
            uint256 balance = IERC20(_token).balanceOf(address(this));

            if (_amount == 0) {
                _amount = balance;
            }
            IERC20(_token).transfer(owner(), _amount);
        }
    }
}
