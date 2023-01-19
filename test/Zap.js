const { expectRevert } = require("@openzeppelin/test-helpers");
const { assert, expect } = require("chai");
const BigNumber = require("bignumber.js");
BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_FLOOR, DECIMAL_PLACES: 0 });
const MockERC20 = artifacts.require("MockERC20");
const {
  checkGasUsed,
  SKIP_EVENT_PARAM_CHECK,
  expectEvent,
  getMockExternalContract,
  getTransactionFee,
} = require("./test-util");
const { constants } = require("ethers");
const { AddressZero } = require("@ethersproject/constants");
const { MaxUint256 } = constants;
contract("Zap", () => {
  const allowableSlippagePercent = 5;
  const maxGasUsed = 1000000;
  const isDebugMode = false;
  let numberOfOriginalLP;
  let factory;
  let router;
  let zap;
  let zapEstimator;
  let deployer;
  let feeTo;
  let weth;
  let intermediateToken1;
  let tokenA;
  let tokenB;
  let tokenC;
  let tokenY;
  let tokenZ;
  let originalTokenList;
  let tokenAddressesInZap;
  let tokenSymbolToToken;
  let tokenAddressToToken;
  let tokenSymbolToTokenAddress;
  let tokenAddressToTokenSymbol;
  let LPAddressToLP;
  let LPAddressToLPName;
  let tokenPairAddressToLPAddress;
  before(async () => {
    const [signer1, signer2] = await ethers.getSigners();
    deployer = signer1;
    feeTo = signer2;
    weth = await getMockExternalContract("WETH", deployer);
    const someOfETHBalance = new BigNumber((await deployer.getBalance()).toString()).dividedToIntegerBy(4).multipliedBy(3).toString(10);
    await weth.deposit({ value: `${someOfETHBalance}` });
    await initializeBasic();
  });
  beforeEach(async () => {
    try {
      await expectVVSZapTokenList(originalTokenList);
      await checkIntermediateTokenList();
      if (!LPAddressToLP || Object.keys(LPAddressToLP).length !== numberOfOriginalLP) {
        await initializeFactory();
      }
    } catch (err) {
      await initializeBasic();
    }
    await zap.fetchLiquidityPoolsFromFactory();
  });
  async function checkIntermediateTokenList () {
    assert.equal((await zap.intermediateTokens(weth.address)).toString(), 0);
    assert.equal((await zap.intermediateTokens(intermediateToken1.address)).toString(), 1);
    assert.equal(await zap.getIntermediateToken(0), weth.address);
    assert.equal(await zap.getIntermediateToken(1), intermediateToken1.address);
    assert.equal(await zap.getIntermediateTokenListLength(), 2);
  }
  async function initializeBasic () {
    if (isDebugMode) {
      console.log("Running initializeBasic...");
    }
    tokenSymbolToToken = {};
    tokenAddressToToken = {};
    tokenSymbolToTokenAddress = {};
    tokenAddressToTokenSymbol = {};
    initializeTokenMap("WETH", weth, weth.address);
    intermediateToken1 = await createToken("VVS", "VVS", "100000000000000000000000000000000");
    tokenA = await createToken("TokenA", "A", "1000000000000000000000000");
    tokenB = await createToken("TokenB", "B", "2000000000000000000000000");
    tokenC = await createToken("TokenC", "C", "4000000000000000000000000");
    tokenY = await createToken("TokenD", "D", "6000000000000000000000000");
    tokenZ = await createToken("TokenZ", "Z", "800000000000000000000");
    originalTokenList = [weth, intermediateToken1, tokenA, tokenB, tokenC];
    tokenAddressesInZap = originalTokenList.map(token => token.address);
    if (isDebugMode) {
      console.log("tokenSymbolToTokenAddress", tokenSymbolToTokenAddress);
    }
    await initializeFactory();
  }
  async function initializeFactory () {
    if (isDebugMode) {
      console.log("Running initializeFactory...");
    }
    LPAddressToLP = {};
    LPAddressToLPName = {};
    tokenPairAddressToLPAddress = {};
    factory = await getMockExternalContract("Factory", deployer, [feeTo.address]);
    router = await getMockExternalContract("Router", deployer, [factory.address, weth.address]);
    await createPairInFactory(weth, intermediateToken1); // 1
    await createPairInFactory(weth, tokenA); // 2
    await createPairInFactory(weth, tokenB); // 3
    await createPairInFactory(weth, tokenC); // 4
    await createPairInFactory(tokenA, tokenB); // 5
    await createPairInFactory(intermediateToken1, tokenC); // 6
    numberOfOriginalLP = 6; // = number of createPairInFactory() within this function
    if (isDebugMode) {
      console.log("LPAddressToLPName", LPAddressToLPName);
    }
    zap = await (await ethers.getContractFactory("Zap")).deploy(weth.address, router.address);
    zapEstimator = await (await ethers.getContractFactory("ZapEstimator")).deploy(zap.address);
    await zap.fetchLiquidityPoolsFromFactory();
    if (isDebugMode) {
      console.log("addIntermediateToken(intermediateToken1)...");
    }
    await zap.addIntermediateToken(intermediateToken1.address);
  }
  async function createToken (name, symbol, totalSupply) {
    const token = await MockERC20.new(name, symbol, `${totalSupply}`);
    initializeTokenMap(symbol, token, token.address);
    return token;
  }
  function initializeTokenMap (symbol, token, tokenAddress) {
    tokenSymbolToToken[symbol] = token;
    tokenAddressToToken[token.address] = token;
    tokenSymbolToTokenAddress[symbol] = tokenAddress;
    tokenAddressToTokenSymbol[tokenAddress] = symbol;
    return token;
  }
  async function createPairInFactory (token0, token1) {
    const token0Address = await token0.address;
    const token1Address = await token1.address;
    if (isDebugMode) {
      console.log(`createPairInFactory ${tokenAddressToTokenSymbol[token0Address]}-${tokenAddressToTokenSymbol[token1Address]}`);
    }
    await factory.createPair(token0Address, token1Address);
    const LPAddress = await factory.getPair(token0Address, token1Address);
    const LP = await ethers.getContractAt("IUniswapV2Pair", LPAddress, deployer);
    LPAddressToLP[LPAddress] = LP;
    LPAddressToLPName[LPAddress] = `${tokenAddressToTokenSymbol[await LP.token0()]}-${
      tokenAddressToTokenSymbol[await LP.token1()]
    }`;
    if (!tokenPairAddressToLPAddress[token0Address]) {
      tokenPairAddressToLPAddress[token0Address] = {};
    }
    tokenPairAddressToLPAddress[token0Address][token1Address] = LPAddress;
    // add liquidity to factory
    await token0.approve(router.address, MaxUint256);
    await token1.approve(router.address, MaxUint256);
    await router.addLiquidity(
      token0Address,
      token1Address,
      "2000000000000000000",
      "2000000000000000000",
      0,
      0,
      deployer.address,
      MaxUint256,
    );
  }
  function getLP (firstToken, secondToken) {
    return LPAddressToLP[tokenPairAddressToLPAddress[firstToken.address][secondToken.address]];
  }
  async function expectVVSZapTokenList (expectedArray) {
    const zapTokenListLength = +((await zap.getTokenListLength()).toString());
    const zapTokenList = [];
    const zapTokens = {};
    for (let i = 0; i < zapTokenListLength; i++) {
      const address = await zap.getToken(i);
      zapTokenList.push(address);
      zapTokens[address] = (await zap.tokens(address)).toString();
    }
    try {
      assert.equal(zapTokenListLength, expectedArray.length);
      for (let i = 0; i < expectedArray.length; i++) {
        const tokenAddress = expectedArray[i].address;
        assert.equal(zapTokenList[i], tokenAddress);
        assert.equal(zapTokens[tokenAddress], i + 1);
        assert.equal(await zap.tokens(tokenAddress), i + 1);
      }
      await expectRevert(
        zap.getToken(expectedArray.length),
        "VM Exception while processing transaction: reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)",
      );
    } catch (err) {
      throw new Error(
        `[expectVVSZapTokenList] token list mismatched as expected: 
        zapTokens = ${JSON.stringify(zapTokens, null, 2)}
        zapTokenList = ${JSON.stringify(zapTokenList, null, 2)}
        expectedArray = ${JSON.stringify(expectedArray.map(token => token.address), null, 2)}
        ${err.message}`);
    }
  }

  async function expectVVSZapIntermediateTokenList (expectedArray) {
    const zapIntermediateTokenListLength = +((await zap.getIntermediateTokenListLength()).toString());
    const zapIntermediateTokenList = [];
    const zapIntermediateTokens = {};
    for (let i = 0; i < zapIntermediateTokenListLength; i++) {
      const address = await zap.getIntermediateToken(i);
      zapIntermediateTokenList.push(address);
      zapIntermediateTokens[address] = (await zap.intermediateTokens(address)).toString();
    }
    try {
      assert.equal(zapIntermediateTokenListLength, expectedArray.length);
      for (let i = 0; i < expectedArray.length; i++) {
        const intermediateTokenAddress = expectedArray[i].address;
        assert.equal(zapIntermediateTokenList[i], intermediateTokenAddress);
        assert.equal(zapIntermediateTokens[intermediateTokenAddress], i + 1);
        assert.equal(await zap.intermediateTokens(intermediateTokenAddress), i + 1);
      }
      await expectRevert(
        zap.getIntermediateToken(expectedArray.length),
        "VM Exception while processing transaction: reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)",
      );
    } catch (err) {
      throw new Error(
        `[expectVVSZapIntermediateTokenList] intermediateToken list mismatched as expected: 
        zapIntermediateTokens = ${JSON.stringify(zapIntermediateTokens, null, 2)}
        zapIntermediateTokenList = ${JSON.stringify(zapIntermediateTokenList, null, 2)}
        expectedArray = ${JSON.stringify(expectedArray.map(intermediateToken => intermediateToken.address), null, 2)}
        ${err.message}`);
    }
  }
  async function expectVVSZapHasNoBalance () {
    for (const token of Object.values(tokenAddressToToken)) {
      const balanceInBaseUnit = await token.balanceOf(zap.address);
      if (+balanceInBaseUnit !== 0) {
        throw new Error(
        `zap contain balance: ${balanceInBaseUnit} ${await token.symbol()}`);
      }
    }
    for (const LP of Object.values(LPAddressToLP)) {
      const balanceInBaseUnit = await LP.balanceOf(zap.address);
      if (+balanceInBaseUnit !== 0) {
        throw new Error(
        `zap contain balance: ${balanceInBaseUnit} ${await LP.symbol()}`);
      }
    }
  }
  describe("zapIn", function () {
    this.timeout(120000);
    const inputAmount = 100000000000000000000;
    beforeEach(async () => {
      await weth.approve(zap.address, MaxUint256);
    });
    it("should revert when target LP not exist in factory and path is not initialized", async () => {
      await createPairInFactory(tokenY, tokenB);
      await zap.fetchLiquidityPoolsFromFactory();
      await expectRevertZapIn(getLP(tokenY, tokenB), inputAmount, "Zap:_getSuitableIntermediateToken: Does not support this route");
    });
    it("should revert when inputAmount = 0", async () => {
      for (const LP of Object.values(LPAddressToLP)) {
        await expectRevertZapIn(LP, 0, "Zap:zapIn: given amount should > 0");
      }
    });
    it("should swap inputToken to LP when LP includes weth", async () => {
      await expectSuccessZapIn(getLP(weth, tokenB), inputAmount);
    });
    it("should swap inputToken to LP when LP not include weth", async () => {
      await expectSuccessZapIn(getLP(tokenA, tokenB), inputAmount);
    });
    async function expectRevertZapIn (LP, inputAmount, expectedErrorMsg) {
      await expectRevert(
        zap.zapIn(LP.address, 0, { value: `${inputAmount}` }),
        expectedErrorMsg,
      );
    }
    async function expectSuccessZapIn (output, inputAmount) {
      const outputBalanceBeforeZapIn = await output.balanceOf(deployer.address);
      let outputAmountMin;
      if (LPAddressToLPName[output.address]) {
        estimation = await zapEstimator.estimateZapInToLpSwapPaths(AddressZero, `${inputAmount}`, output.address);
        outputAmountMin = (await zapEstimator.estimateAddLiquidityOutputAmount(estimation[2], estimation[3], output.address)).toString();
      } else {
        const [estimatedPath, estimatedAmounts] = await zapEstimator.estimateZapTokenToTokenAmountsOut(AddressZero, output.address, `${
          inputAmount}`);
        outputAmountMin = estimatedAmounts[estimatedAmounts.length - 1].toString();
      }
      outputAmountMin = new BigNumber(outputAmountMin).multipliedBy(allowableSlippagePercent / 100).toString(10);
      const inputTokenBalanceBeforeZapIn = new BigNumber((await deployer.getBalance()).toString());
      const transaction = await zap.zapIn(output.address, `${outputAmountMin}`, { value: `${inputAmount}` });
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "ZapIn", [output.address, inputAmount, SKIP_EVENT_PARAM_CHECK]);
      const inputTokenBalanceAfterZapIn = new BigNumber((await deployer.getBalance()).toString());
      const ETHBalanceDiff = inputTokenBalanceBeforeZapIn
        .minus(inputTokenBalanceAfterZapIn.toString())
        .minus(await getTransactionFee(transaction))
        .toString();
      assert.equal(
        ETHBalanceDiff,
        inputAmount,
      );
      assert.equal((await output.balanceOf(deployer.address)) > outputBalanceBeforeZapIn, true);
      await expectVVSZapHasNoBalance();
    }
  });
  describe("zapInToken", function () {
    this.timeout(120000);
    let inputToken;
    let LP;
    const inputAmount = 10000;
    describe("when no inputToken-intermediateTokens pair exist in factory", () => {
      beforeEach(async () => {
        inputToken = tokenY;
        LP = getLP(tokenA, tokenB);
        await createPairInFactory(inputToken, tokenC);
      });
      it("should swap to LP when path is initialized", async () => {
        await zap.setPresetPath(inputToken.address, weth.address, [inputToken.address, tokenC.address, weth.address]);
        await expectSuccessZapInToken(inputToken, LP, inputAmount);
      });
      it("should revert when path is not initialized", async () => {
        await zap.fetchLiquidityPoolsFromFactory();
        await expectRevertZapInToken(inputToken, LP, inputAmount,
          "Zap:_getPathForTokenToToken: Does not support this route");
      });
    });
    describe("when to is token", () => {
      it("should revert when inputToken is not supported", async () => {
        for (const inputToken of [tokenY, tokenZ]) {
          for (const outputTokenAddress of tokenAddressesInZap) {
            await expectRevertZapInToken(inputToken, tokenAddressToToken[outputTokenAddress], inputAmount,
              "Zap:zapInToken: given fromToken is not token");
          }
        }
      });
      it("should revert when inputToken = targetToken", async () => {
        for (const inputTokenAddress of tokenAddressesInZap) {
          const inputToken = tokenAddressToToken[inputTokenAddress];
          await expectRevertZapInToken(inputToken, inputToken, inputAmount,
            "Zap:_swapTokenToToken: Not Allow fromToken == toToken");
        }
      });
      it("should swap inputToken to targetToken when inputToken != targetToken", async () => {
        for (const inputTokenAddress of tokenAddressesInZap) {
          for (const outputTokenAddress of tokenAddressesInZap) {
            if (inputTokenAddress === outputTokenAddress) {
              continue;
            }
            await expectSuccessZapInToken(tokenAddressToToken[inputTokenAddress], tokenAddressToToken[outputTokenAddress], inputAmount);
          }
        }
      });
    });
    it("should swap inputToken to LP ", async () => {
      for (const inputToken of originalTokenList) {
        for (const LPAddress of Object.keys(LPAddressToLP)) {
          // console.log(`${tokenAddressToTokenSymbol[inputToken.address]} -> ${LPAddressToLPName[LPAddress]}`);
          await expectSuccessZapInToken(inputToken, LPAddressToLP[LPAddress], inputAmount);
        }
      }
    });
    async function expectRevertZapInToken (inputToken, output, inputAmount, expectedErrorMsg) {
      const inputTokenBalanceBeforeZapIn = await inputToken.balanceOf(deployer.address);
      await inputToken.approve(zap.address, MaxUint256);
      await expectRevert(
        zap.zapInToken(inputToken.address, inputAmount, output.address, 0),
        expectedErrorMsg,
      );
      assert.deepEqual(await inputToken.balanceOf(deployer.address), inputTokenBalanceBeforeZapIn);
    }
    async function expectSuccessZapInToken (inputToken, output, inputAmount) {
      const inputTokenBalanceBeforeZapIn = await inputToken.balanceOf(deployer.address);
      await zap.fetchLiquidityPoolsFromFactory();
      await inputToken.approve(zap.address, MaxUint256);
      outputBalanceBeforeZapIn = await output.balanceOf(deployer.address);
      let outputAmountMin;
      if (LPAddressToLPName[output.address]) {
        estimation = await zapEstimator.estimateZapInToLpSwapPaths(inputToken.address, inputAmount, output.address);
        outputAmountMin = (await zapEstimator.estimateAddLiquidityOutputAmount(estimation[2], estimation[3], output.address)).toString();
      } else {
        const [estimatedPath, estimatedAmounts] = await zapEstimator.estimateZapTokenToTokenAmountsOut(
          inputToken.address, output.address, inputAmount);
        outputAmountMin = estimatedAmounts[estimatedAmounts.length - 1].toString();
      }
      outputAmountMin = new BigNumber(outputAmountMin).multipliedBy(allowableSlippagePercent / 100).toString(10);
      const transaction = await zap.zapInToken(inputToken.address, inputAmount, output.address, outputAmountMin);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "ZapInToken", [inputToken.address, output.address, inputAmount, SKIP_EVENT_PARAM_CHECK]);
      const inputTokenBalanceAfterZapInInBaseUnit = await inputToken.balanceOf(deployer.address);
      assert.equal(
        // should be equal. but there is some remaining token did not stake as LP which will return to user, therefore more then expected
        new BigNumber(inputTokenBalanceBeforeZapIn.toString()).minus(inputAmount)
          .isLessThanOrEqualTo(inputTokenBalanceAfterZapInInBaseUnit.toString()),
        true,
      );
      const outputBalanceAfterZapIn = new BigNumber((await output.balanceOf(deployer.address)).toString());
      assert.equal(outputBalanceAfterZapIn.isGreaterThan(outputBalanceBeforeZapIn.toString()), true);
      assert.equal(
        outputBalanceAfterZapIn.minus(outputBalanceBeforeZapIn.toString())
          .isGreaterThanOrEqualTo(outputAmountMin)
        , true,
      );
      await expectVVSZapHasNoBalance();
    }
  });
  describe("zapOut", function () {
    this.timeout(120000);
    const inputAmount = 100000000;
    it("should revert when outputToken is not supported", async () => {
      for (const input of Object.values(LPAddressToLP)) {
        for (const output of [tokenY, tokenZ]) {
          await expectRevertZapOut(input, 0, output, "Zap:zapOut: given amount should > 0");
        }
      }
    });
    it("should revert when inputAmount = 0", async () => {
      for (const input of Object.values(LPAddressToLP)) {
        for (const output of Object.values(LPAddressToLP)) {
          if (input.address === output.address) {
            continue;
          }
          await expectRevertZapOut(input, 0, output, "Zap:zapOut: given amount should > 0");
        }
      }
    });
    it("should revert when input is not LP", async () => {
      for (const input of originalTokenList) {
        for (const output of Object.values(LPAddressToLP)) {
          await expectRevertZapOut(input, inputAmount, output, "Zap:zapOut: should zap out from LP Address");
        }
      }
    });
    it("should revert when input LP = output LP", async () => {
      for (const input of Object.values(LPAddressToLP)) {
        for (const output of Object.values(LPAddressToLP)) {
          if (input.address === output.address) {
            await expectRevertZapOut(input, inputAmount, output, "Zap:zapOut: input = output");
          }
        }
      }
    });
    it("should swap LP to token", async () => {
      for (const input of Object.values(LPAddressToLP)) {
        for (const output of originalTokenList) {
          await expectSuccessZapOut(input, inputAmount, output);
        }
      }
    });
    it("should swap LP to LP", async () => {
      for (const input of Object.values(LPAddressToLP)) {
        for (const output of Object.values(LPAddressToLP)) {
          if (input.address === output.address) {
            continue;
          }
          await expectSuccessZapOut(input, inputAmount, output);
        }
      }
    });
    it("should swap LP to ETH", async () => {
      for (const input of Object.values(LPAddressToLP)) {
        await input.approve(zap.address, MaxUint256);
        const inputBalanceBeforeZapOut = await input.balanceOf(deployer.address);
        const outputBalanceBeforeZapOut = await deployer.getBalance();
        const estimation = await zapEstimator.estimateZapOutToTokenOutputAmount(input.address, inputAmount, constants.AddressZero);
        const outputAmountMin = new BigNumber(estimation[2].toString()).multipliedBy(allowableSlippagePercent / 100).toString(10);
        const transaction = await zap.zapOut(input.address, inputAmount, constants.AddressZero, 0);
        await checkGasUsed(transaction, { maxGasUsed });
        await expectEvent(transaction, "ZapOut", [input.address, constants.AddressZero, inputAmount, SKIP_EVENT_PARAM_CHECK]);
        assert.equal(
          await input.balanceOf(deployer.address),
          new BigNumber(inputBalanceBeforeZapOut.toString()).minus(inputAmount).toString(10),
        );
        const currentDeployerETHBalance = new BigNumber((await deployer.getBalance()).toString());
        const ETHBalanceDiff = currentDeployerETHBalance
          .minus(outputBalanceBeforeZapOut.toString())
          .plus(await getTransactionFee(transaction));
        assert.equal(
          currentDeployerETHBalance.isGreaterThan(new BigNumber(outputBalanceBeforeZapOut.toString()).minus(await getTransactionFee(transaction)))
          , true,
        );
        assert.equal(
          ETHBalanceDiff.isGreaterThanOrEqualTo(outputAmountMin)
          , true,
        );
      }
    });
    async function expectRevertZapOut (input, inputAmount, output, expectedErrorMsg) {
      const inputBalanceBeforeZapOut = await input.balanceOf(deployer.address);
      const outputBalanceBeforeZapOut = await output.balanceOf(deployer.address);
      await input.approve(zap.address, MaxUint256);
      await expectRevert(
        zap.zapOut(input.address, inputAmount, output.address, 0),
        expectedErrorMsg,
      );
      assert.deepEqual(await input.balanceOf(deployer.address), inputBalanceBeforeZapOut);
      assert.deepEqual(await output.balanceOf(deployer.address), outputBalanceBeforeZapOut);
    }
    async function expectSuccessZapOut (input, inputAmount, output) {
      await input.approve(zap.address, MaxUint256);
      const inputBalanceBeforeZapOut = await input.balanceOf(deployer.address);
      const outputBalanceBeforeZapOut = await output.balanceOf(deployer.address);
      const transaction = await zap.zapOut(input.address, inputAmount, output.address, 0);// %%%%
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "ZapOut", [input.address, output.address, inputAmount, SKIP_EVENT_PARAM_CHECK]);
      await zap.fetchLiquidityPoolsFromFactory();
      assert.equal(
        await input.balanceOf(deployer.address),
        new BigNumber(inputBalanceBeforeZapOut.toString()).minus(inputAmount).toString(10),
      );
      assert.equal((await output.balanceOf(deployer.address)) > outputBalanceBeforeZapOut, true);
      const outputBalanceAfterZapOut = new BigNumber((await output.balanceOf(deployer.address)).toString());
      if (tokenAddressToTokenSymbol[output.address]) {
        const estimation = await zapEstimator.estimateZapOutToTokenOutputAmount(input.address, inputAmount, output.address);
        const outputBalanceDiff = outputBalanceAfterZapOut.minus(outputBalanceBeforeZapOut.toString());
        assert.equal(
          outputBalanceDiff.isGreaterThanOrEqualTo((estimation[2] * 0.95).toString())
          , true,
        );
      }
      await expectVVSZapHasNoBalance();
    }
  });
  describe("getPresetPath / setPresetPath / removePresetPath / setPresetPathByAutoCalculation", () => {
    it("should return correct path from zap.paths", async () => {
      assert.deepEqual(await zap.getPresetPath(tokenC.address, tokenA.address), []);
      const path = [tokenC.address, weth.address, tokenA.address];
      // setPresetPath
      let transaction = await zap.setPresetPath(tokenC.address, tokenA.address, path);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "SetPresetPath", [tokenC.address, tokenA.address, path, false]);
      assert.deepEqual(await zap.getPresetPath(tokenC.address, tokenA.address), path);
      // removePresetPath
      transaction = await zap.removePresetPath(tokenC.address, tokenA.address);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "RemovePresetPath", [tokenC.address, tokenA.address]);
      assert.deepEqual(await zap.getPresetPath(tokenC.address, tokenA.address), []);
      transaction = await zap.setPresetPathByAutoCalculation(tokenC.address, tokenA.address);
      // setPresetPathByAutoCalculation
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "SetPresetPath", [tokenC.address, tokenA.address, path, true]);
      assert.deepEqual(await zap.getPresetPath(tokenC.address, tokenA.address), path);
    });
  });
  describe("getLiquidityPoolAddress", () => {
    it("should return correct address from factory", async () => {
      for (const [token1, token2] of [
        [weth, tokenA],
        [weth, tokenB],
        [tokenA, tokenB],
      ]) {
        assert.equal(
          await zap.getLiquidityPoolAddress(token1.address, token2.address),
          tokenPairAddressToLPAddress[token1.address][token2.address],
        );
      }
    });
  });
  describe("isLiquidityPoolExistInFactory", () => {
    it("should return correct result according to factory getPair", async () => {
      assert.equal(await zap.isLiquidityPoolExistInFactory(weth.address, tokenA.address), true);
      assert.equal(await zap.isLiquidityPoolExistInFactory(weth.address, tokenB.address), true);
      assert.equal(await zap.isLiquidityPoolExistInFactory(weth.address, tokenC.address), true);
      assert.equal(await zap.isLiquidityPoolExistInFactory(tokenA.address, tokenB.address), true);
      assert.equal(await zap.isLiquidityPoolExistInFactory(tokenA.address, tokenC.address), false);
      assert.equal(await zap.isLiquidityPoolExistInFactory(tokenB.address, tokenC.address), false);
    });
  });
  describe("fetchLiquidityPoolsFromFactoryWithIndex / getToken / addToken / removeToken / getTokenListLength", () => {
    const maxGasUsedForTokenUpdate = 400000;
    it("should add new token to tokenList and tokenSymbolToToken by addToken", async () => {
      const transaction = await zap.addToken(tokenZ.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "AddToken", [tokenZ.address, false]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenA, tokenB, tokenC, tokenZ]);
    });
    it("should remove token from tokenList and tokenSymbolToToken by removeToken", async () => {
      const transaction = await zap.removeToken(tokenA.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "RemoveToken", [tokenA.address]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenC, tokenB]);
    });
    it("should revert when intermediate token already exist", async () => {
      await expectRevert(
        zap.addToken(weth.address),
        "Zap:addToken: _tokenAddress is already in token list",
      );
      await expectRevert(
        zap.addToken(intermediateToken1.address),
        "Zap:addToken: _tokenAddress is already in token list",
      );
    });
    it("should remove token from tokenList and tokenSymbolToToken and add it back again", async () => {
      // remove tokenA
      let transaction = await zap.removeToken(tokenA.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "RemoveToken", [tokenA.address]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenC, tokenB]);
      // add tokenA back
      transaction = await zap.addToken(tokenA.address);
      await expectEvent(transaction, "AddToken", [tokenA.address, false]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenC, tokenB, tokenA]);
      // remove tokenA again
      transaction = await zap.removeToken(tokenA.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "RemoveToken", [tokenA.address]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenC, tokenB]);
      // add tokenA back again
      transaction = await zap.addToken(tokenA.address);
      await expectEvent(transaction, "AddToken", [tokenA.address, false]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenC, tokenB, tokenA]);
    });
    it("should update tokens and tokenList correctly when addToken or removeToken again and again", async () => {
      let transaction = await zap.addToken(tokenZ.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "AddToken", [tokenZ.address, false]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenA, tokenB, tokenC, tokenZ]);
      transaction = await zap.removeToken(tokenA.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "RemoveToken", [tokenA.address]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenZ, tokenB, tokenC]);
      transaction = await zap.addToken(tokenA.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "AddToken", [tokenA.address, false]);
      transaction = await zap.addToken(tokenY.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "AddToken", [tokenY.address, false]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenZ, tokenB, tokenC, tokenA, tokenY]);
      transaction = await zap.removeToken(tokenC.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "RemoveToken", [tokenC.address]);
      await expectVVSZapTokenList([weth, intermediateToken1, tokenZ, tokenB, tokenY, tokenA]);
      transaction = await zap.removeToken(weth.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "RemoveToken", [weth.address]);
      await expectVVSZapTokenList([tokenA, intermediateToken1, tokenZ, tokenB, tokenY]);
      transaction = await zap.removeToken(tokenY.address);
      await checkGasUsed(transaction, { maxGasUsedForTokenUpdate });
      await expectEvent(transaction, "RemoveToken", [tokenY.address]);
      await expectVVSZapTokenList([tokenA, intermediateToken1, tokenZ, tokenB]);
    });
  });
  describe("get / set / remove IntermediateToken  / getIntermediateTokenListLength", () => {
    it("should only contain WETH right after Zap created", async () => {
      assert.equal(await zap.getIntermediateToken(0), weth.address);
      assert.equal(await zap.getIntermediateToken(1), intermediateToken1.address);
      assert.equal(await zap.getIntermediateTokenListLength(), 2);
    });
    it("should revert when intermediate token already exist", async () => {
      await expectRevert(
        zap.addIntermediateToken(weth.address),
        "Zap:addIntermediateToken: _tokenAddress is already in token list",
      );
      await expectRevert(
        zap.addIntermediateToken(intermediateToken1.address),
        "Zap:addIntermediateToken: _tokenAddress is already in token list",
      );
    });
    it("should add new token to intermediateTokenList by addIntermediateToken", async () => {
      const transaction = await zap.addIntermediateToken(tokenY.address);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "AddIntermediateToken", [tokenY.address]);
      assert.equal(await zap.getIntermediateToken(0), weth.address);
      assert.equal(await zap.getIntermediateToken(1), intermediateToken1.address);
      assert.equal(await zap.getIntermediateToken(2), tokenY.address);
      assert.equal(await zap.intermediateTokens(weth.address), 1);
      assert.equal((await zap.intermediateTokens(intermediateToken1.address)).toString(), 2);
      assert.equal((await zap.intermediateTokens(tokenY.address)).toString(), 3);
      await expectRevert(
        zap.getIntermediateToken(3),
        "VM Exception while processing transaction: reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)",
      );
      assert.equal(await zap.getIntermediateTokenListLength(), 3);
    });
    it("should remove token from intermediateTokenList by removeIntermediateToken", async () => {
      const transaction = await zap.removeIntermediateToken(weth.address);
      assert.equal((await zap.intermediateTokens(weth.address)).toString(), 0);
      assert.equal((await zap.intermediateTokens(intermediateToken1.address)).toString(), 1);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "RemoveIntermediateToken", [weth.address]);
      await expectRevert(
        zap.getIntermediateToken(1),
        "VM Exception while processing transaction: reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)",
      );
      assert.equal(await zap.getIntermediateTokenListLength(), 1);
    });
    it("should remove token from intermediateTokenList and add it back again", async () => {
      await expectVVSZapIntermediateTokenList([weth, intermediateToken1]);
      // remove weth
      let transaction = await zap.removeIntermediateToken(weth.address);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "RemoveIntermediateToken", [weth.address]);
      await expectVVSZapIntermediateTokenList([intermediateToken1]);

      // add weth back again
      transaction = await zap.addIntermediateToken(weth.address);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "AddIntermediateToken", [weth.address]);
      await expectVVSZapIntermediateTokenList([intermediateToken1, weth]);

      // remove weth again
      transaction = await zap.removeIntermediateToken(weth.address);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "RemoveIntermediateToken", [weth.address]);
      await expectVVSZapIntermediateTokenList([intermediateToken1]);

      // add weth back again
      transaction = await zap.addIntermediateToken(weth.address);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "AddIntermediateToken", [weth.address]);
      await expectVVSZapIntermediateTokenList([intermediateToken1, weth]);

      // remove intermediateToken1
      transaction = await zap.removeIntermediateToken(intermediateToken1.address);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "RemoveIntermediateToken", [intermediateToken1.address]);
      await expectVVSZapIntermediateTokenList([weth]);
    });
  });
  describe("addLiquidityPool / isLP / removeLiquidityPool", () => {
    it("should return false when for token addresses", async () => {
      for (const address of Object.keys(tokenAddressToToken)) {
        assert.equal(await zap.isLP(address), false);
      }
    });
    it("should return true when for lp addresses", async () => {
      for (const address of Object.keys(LPAddressToLP)) {
        assert.equal(await zap.isLP(address), true);
      }
    });
    it("should return according to liquidityPools", async () => {
      for (const address of Object.keys(tokenAddressToToken)) {
        assert.equal(await zap.isLP(address), false);
      }
      for (const address of Object.keys(LPAddressToLP)) {
        assert.equal(await zap.isLP(address), true);
      }
      await createPairInFactory(tokenY, tokenA);
      const targetLPAddress = getLP(tokenY, tokenA).address;
      assert.equal(await zap.isLP(targetLPAddress), false);
      let transaction = await zap.addLiquidityPool(targetLPAddress);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "AddLiquidityPool", [targetLPAddress, false]);
      assert.equal(await zap.isLP(targetLPAddress), true);
      transaction = await zap.removeLiquidityPool(targetLPAddress);
      await checkGasUsed(transaction, { maxGasUsed });
      await expectEvent(transaction, "RemoveLiquidityPool", [targetLPAddress]);
      assert.equal(await zap.isLP(targetLPAddress), false);
      await initializeFactory();
    });
  });
  describe("fetchLiquidityPoolsFromFactory", () => {
    it("when only 1 token in new LP do not exist in original tokenList", async () => {
      const transaction = await zap.fetchLiquidityPoolsFromFactory();
      const lastLPIndex = Object.keys(LPAddressToLP).length - 1;
      try {
        await checkGasUsed(transaction, { maxGasUsed });
        await expectEvent(transaction, "FetchLiquidityPoolsFromFactory", [0, lastLPIndex]);
      } catch (err) {
        expect(err.message).to.be.contains("Expected event not exist");
      }
    });
  });
  describe("fetchLiquidityPoolsFromFactoryWithIndex / isToken / isLP/ getToken / getTokenListLength", () => {
    describe("should have new tokens and LPs according to after fetchLiquidityPoolsFromFactoryWithIndex", function () {
      this.timeout(120000);
      it("when only 1 token in new LP do not exist in original tokenList", async () => {
        for (const newToken of [tokenY, tokenZ]) {
          for (const oldToken of originalTokenList) {
            await initializeFactory();
            await expectCorrect(newToken, oldToken, [...originalTokenList, newToken]);
          }
        }
      });
      it("when both token in new LP do not exist in original tokenList", async () => {
        let expectedFinalTokenList;
        if (+tokenY.address < +tokenZ.address) {
          expectedFinalTokenList = [...originalTokenList, tokenY, tokenZ];
        } else {
          expectedFinalTokenList = [...originalTokenList, tokenZ, tokenY];
        }
        await expectCorrect(tokenY, tokenZ, expectedFinalTokenList);
      });
      async function expectCorrect (newLPToken1, newLPToken2, expectedFinalTokenList) {
        for (const address of tokenAddressesInZap) {
          assert.equal(await zap.isToken(address), true);
        }
        for (const address of Object.keys(LPAddressToLP)) {
          assert.equal(await zap.isLP(address), true);
        }
        await expectVVSZapTokenList(originalTokenList);
        await createPairInFactory(newLPToken1, newLPToken2);
        await expectVVSZapTokenList(originalTokenList);
        let transaction = await zap.fetchLiquidityPoolsFromFactoryWithIndex(0, 10);
        await expectVVSZapTokenList(expectedFinalTokenList);
        const lastLPIndex = Object.keys(LPAddressToLP).length - 1;
        await checkGasUsed(transaction, { maxGasUsed });
        await expectEvent(transaction, "FetchLiquidityPoolsFromFactory", [0, lastLPIndex]);
        for (const address of Object.keys(LPAddressToLP)) {
          assert.equal(await zap.isLP(address), true);
        }
        for (const token of expectedFinalTokenList) {
          assert.equal(await zap.isToken(token.address), true);
        }
        assert.equal(await zap.lastFetchedPairIndex(), lastLPIndex);
        transaction = await zap.fetchLiquidityPoolsFromFactoryWithIndex(lastLPIndex, 10);
        await checkGasUsed(transaction, { maxGasUsed });
        await expectEvent(transaction, "FetchLiquidityPoolsFromFactory", [lastLPIndex, lastLPIndex]);
      }
    });
  });
  describe("getAutoCalculatedPathWithIntermediateTokenForTokenToToken", () => {
    it("should return correct auto path", async () => {
      await createPairInFactory(tokenZ, intermediateToken1);
      await createPairInFactory(tokenB, intermediateToken1);
      await zap.fetchLiquidityPoolsFromFactory();
      assert.deepEqual(
        await zap.getAutoCalculatedPathWithIntermediateTokenForTokenToToken(tokenZ.address, tokenB.address),
        [tokenZ.address, intermediateToken1.address, tokenB.address],
      );
      await createPairInFactory(tokenB, tokenZ);
      await zap.fetchLiquidityPoolsFromFactory();
      assert.deepEqual(
        await zap.getAutoCalculatedPathWithIntermediateTokenForTokenToToken(tokenZ.address, tokenB.address),
        [tokenZ.address, intermediateToken1.address, tokenB.address],
      );
      await zap.addIntermediateToken(tokenZ.address);
      assert.deepEqual(
        await zap.getAutoCalculatedPathWithIntermediateTokenForTokenToToken(tokenZ.address, tokenB.address),
        [tokenZ.address, intermediateToken1.address, tokenB.address],
      );
    });
  });
  describe("getPathForTokenToToken", () => {
    it("should return correct path", async () => {
      assert.deepEqual(await zap.getPathForTokenToToken(tokenA.address, tokenB.address), [tokenA.address, tokenB.address]);
      assert.deepEqual(await zap.getPathForTokenToToken(tokenC.address, tokenA.address), [tokenC.address, weth.address, tokenA.address]);
      assert.deepEqual(await zap.getPathForTokenToToken(tokenC.address, tokenB.address), [tokenC.address, weth.address, tokenB.address]);
    });
    it("should return correct path for new pair", async () => {
      await createPairInFactory(tokenZ, intermediateToken1);
      await createPairInFactory(tokenB, intermediateToken1);
      await zap.fetchLiquidityPoolsFromFactory();
      assert.deepEqual(await zap.getPathForTokenToToken(tokenZ.address, tokenB.address), [tokenZ.address, intermediateToken1.address, tokenB.address]);
      await zap.addIntermediateToken(tokenZ.address);
      assert.deepEqual(await zap.getPathForTokenToToken(tokenZ.address, tokenB.address), [tokenZ.address, intermediateToken1.address, tokenB.address]);
    });
  });
  describe("getSuitableIntermediateTokenForTokenToLP", () => {
    it("should return correct SuitableIntermediateToken", async () => {
      await createPairInFactory(tokenZ, intermediateToken1);
      await createPairInFactory(tokenA, tokenC);
      for (const [inputToken, pair, expectedIntermediateToken] of [
        [weth, [weth, tokenA], weth], // IntermediateToken is not necessary
        [intermediateToken1, [weth, tokenA], weth],
        [intermediateToken1, [weth, tokenC], weth],
        [intermediateToken1, [intermediateToken1, tokenC], intermediateToken1], // IntermediateToken is not necessary
        [tokenA, [weth, tokenA], tokenA], // IntermediateToken is not necessary
        [tokenA, [intermediateToken1, tokenC], intermediateToken1],
        [tokenC, [intermediateToken1, tokenC], tokenC], // IntermediateToken is not necessary
        [weth, [weth, intermediateToken1], weth], // IntermediateToken is not necessary
        [intermediateToken1, [weth, intermediateToken1], intermediateToken1], // IntermediateToken is not necessary
        [tokenA, [tokenA, tokenB], tokenA], // IntermediateToken is not necessary
        [tokenZ, [tokenA, tokenB], weth], // no direct LP for intermediateToken1-tokenA intermediateToken1-tokenB
        [tokenA, [tokenA, tokenC], tokenA], // IntermediateToken is not necessary
        [tokenZ, [tokenA, tokenC], weth], // even if there is direct LP for intermediateToken1-tokenZ, weth is pick as it doesnt do path length comparison
        [tokenZ, [weth, intermediateToken1], intermediateToken1], // both weth intermediateToken1 are IntermediateToken, but intermediateToken1 is pick because of intermediateToken1-tokenZ exist
      ]) {
        assert.deepEqual(
          await zap.getSuitableIntermediateTokenForTokenToLP(inputToken.address,
            tokenPairAddressToLPAddress[pair[0].address][pair[1].address]),
          expectedIntermediateToken.address,
        );
      }
    });
  });
  describe("withdrawBalance", () => {
    const amount = 2000;
    it("should withdraw all balance when withdrawBalance with amount 0 (ERC20)", async () => {
      await tokenA.transfer(zap.address, amount);
      const balance = await tokenA.balanceOf(deployer.address);
      await zap.withdrawBalance(tokenA.address, 0);
      assert.equal(+(await tokenA.balanceOf(deployer.address)), +balance + amount);
    });
    it("should withdraw all balance when withdrawBalance with amount 0 (ETH)", async () => {
      await deployer.sendTransaction({ to: zap.address, value: amount });
      const balance = await deployer.getBalance();
      const transaction = await zap.withdrawBalance(AddressZero, 0);
      assert.deepEqual(
        (await deployer.getBalance()).toString(),
        new BigNumber(balance.toString()).plus(amount).minus(await getTransactionFee(transaction)).toString(10),
      );
    });
    it("should withdraw when withdrawBalance for all balance (ERC20)", async () => {
      await tokenA.transfer(zap.address, amount);
      const balance = await tokenA.balanceOf(deployer.address);
      await zap.withdrawBalance(tokenA.address, amount);
      assert.equal(+(await tokenA.balanceOf(deployer.address)), +balance + amount);
    });
    it("should withdraw when withdrawBalance for all balance (ETH)", async () => {
      await deployer.sendTransaction({ to: zap.address, value: amount });
      const balance = await deployer.getBalance();
      const transaction = await zap.withdrawBalance(AddressZero, amount);
      assert.deepEqual(
        (await deployer.getBalance()).toString(),
        new BigNumber(balance.toString()).plus(amount).minus(await getTransactionFee(transaction)).toString(10),
      );
    });
    it("should withdraw when withdrawBalance for part of balance (ERC20)", async () => {
      await tokenA.transfer(zap.address, amount);
      const balance = await tokenA.balanceOf(deployer.address);
      await zap.withdrawBalance(tokenA.address, amount / 2);
      assert.equal(+(await tokenA.balanceOf(deployer.address)), +balance + amount / 2);
    });
    it("should withdraw when withdrawBalance for part of balance (ETH)", async () => {
      await deployer.sendTransaction({ to: zap.address, value: amount });
      const balance = await deployer.getBalance();
      const transaction = await zap.withdrawBalance(AddressZero, amount / 2);
      assert.deepEqual(
        (await deployer.getBalance()).toString(),
        new BigNumber(balance.toString()).plus(amount / 2).minus(await getTransactionFee(transaction)).toString(10),
      );
    });
  });
});
