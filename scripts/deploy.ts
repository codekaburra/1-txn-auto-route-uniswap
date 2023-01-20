require("hardhat").ethers;

async function main () {
  const WETHAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const uniswapRouterAddress = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const Zap = await ethers.getContractFactory("Zap");
  const zap = await Zap.deploy(WETHAddress, uniswapRouterAddress);
  await zap.deployed();
  console.log(`Zap with ${JSON.stringify({ WETHAddress, uniswapRouterAddress })} is deployed to ${zap.address}`);

  const ZapEstimator = await ethers.getContractFactory("ZapEstimator");
  const zapEstimator = await ZapEstimator.deploy(zap.address);
  await zapEstimator.deployed();
  console.log(`ZapEstimator for ap ${zap.address} is deployed to ${zap.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
