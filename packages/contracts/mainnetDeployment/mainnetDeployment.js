const { UniswapV2Factory } = require("./ABIs/UniswapV2Factory.js");
const { UniswapV2Pair } = require("./ABIs/UniswapV2Pair.js");
const { UniswapV2Router02 } = require("./ABIs/UniswapV2Router02.js");
const { ChainlinkAggregatorV3Interface } = require("./ABIs/ChainlinkAggregatorV3Interface.js");
const { TestHelper: th, TimeValues: timeVals } = require("../utils/testHelpers.js");
const { dec } = th;
const MainnetDeploymentHelper = require("../utils/mainnetDeploymentHelpers.js");
const toBigNum = ethers.BigNumber.from;

async function mainnetDeploy(configParams) {
  const date = new Date();
  console.log(date.toUTCString());
  const deployerWallet = (await ethers.getSigners())[0];
  const mdh = new MainnetDeploymentHelper(configParams, deployerWallet);
  const gasPrice = configParams.GAS_PRICE;

  const deploymentState = mdh.loadPreviousDeployment();

  console.log(`deployer address: ${deployerWallet.address}`);
  assert.equal(deployerWallet.address, configParams.liquityAddrs.DEPLOYER);
  let deployerETHBalance = await ethers.provider.getBalance(deployerWallet.address);
  console.log(`deployerETHBalance before: ${deployerETHBalance}`);

  // Get UniswaV2Factory instance at its deployed address
  const uniswapV2Factory = new ethers.Contract(
    configParams.externalAddrs.UNISWAP_V2_FACTORY,
    UniswapV2Factory.abi,
    deployerWallet
  );

  console.log(`Uniswp addr: ${uniswapV2Factory.address}`);
  const uniAllPairsLength = await uniswapV2Factory.allPairsLength();
  console.log(`Uniswap Factory number of pairs: ${uniAllPairsLength}`);

  deployerETHBalance = await ethers.provider.getBalance(deployerWallet.address);
  console.log(`deployer's ETH balance before deployments: ${deployerETHBalance}`);

  // Deploy core logic contracts
  const liquityCore = await mdh.deployLiquityCoreMainnet(
    configParams.externalAddrs.TELLOR_MASTER,
    deploymentState
  );
  await mdh.logContractObjects(liquityCore);

  // Check Uniswap Pair USDD-ETH pair before pair creation
  let USDDWETHPairAddr = await uniswapV2Factory.getPair(
    liquityCore.usddToken.address,
    configParams.externalAddrs.WETH_ERC20
  );
  let WETHUSDDPairAddr = await uniswapV2Factory.getPair(
    configParams.externalAddrs.WETH_ERC20,
    liquityCore.usddToken.address
  );
  assert.equal(USDDWETHPairAddr, WETHUSDDPairAddr);

  if (USDDWETHPairAddr == th.ZERO_ADDRESS) {
    // Deploy Unipool for USDD-WETH
    await mdh.sendAndWaitForTransaction(
      uniswapV2Factory.createPair(
        configParams.externalAddrs.WETH_ERC20,
        liquityCore.usddToken.address,
        { gasPrice }
      )
    );

    // Check Uniswap Pair USDD-WETH pair after pair creation (forwards and backwards should have same address)
    USDDWETHPairAddr = await uniswapV2Factory.getPair(
      liquityCore.usddToken.address,
      configParams.externalAddrs.WETH_ERC20
    );
    assert.notEqual(USDDWETHPairAddr, th.ZERO_ADDRESS);
    WETHUSDDPairAddr = await uniswapV2Factory.getPair(
      configParams.externalAddrs.WETH_ERC20,
      liquityCore.usddToken.address
    );
    console.log(`USDD-WETH pair contract address after Uniswap pair creation: ${USDDWETHPairAddr}`);
    assert.equal(WETHUSDDPairAddr, USDDWETHPairAddr);
  }

  // Deploy Unipool
  const unipool = await mdh.deployUnipoolMainnet(deploymentState);

  // Deploy DEFT Contracts
  const DEFTContracts = await mdh.deployDEFTContractsMainnet(
    deploymentState,
    configParams.externalAddrs.AAB_ERC20
  );

  // Connect all core contracts up
  await mdh.connectCoreContractsMainnet(
    liquityCore,
    DEFTContracts,
    configParams.externalAddrs.CHAINLINK_ETHUSD_PROXY
  );

  await mdh.connectDEFTContractsToCoreMainnet(DEFTContracts, liquityCore);

  // Deploy a read-only multi-trove getter
  const multiTroveGetter = await mdh.deployMultiTroveGetterMainnet(liquityCore, deploymentState);

  // Connect Unipool to DEFTToken and the USDD-WETH pair address, with a 6 week duration
  // const LPRewardsDuration = timeVals.SECONDS_IN_SIX_WEEKS
  await mdh.connectUnipoolMainnet(unipool, DEFTContracts, USDDWETHPairAddr);

  // Log DEFT and Unipool addresses
  await mdh.logContractObjects(DEFTContracts);
  console.log(`Unipool address: ${unipool.address}`);

  let latestBlock = await ethers.provider.getBlockNumber();
  let now = (await ethers.provider.getBlock(latestBlock)).timestamp;

  console.log(`time now: ${now}`);
  const oneYearFromNow = (now + timeVals.SECONDS_IN_ONE_YEAR).toString();
  console.log(`time oneYearFromNow: ${oneYearFromNow}`);

  // // --- TESTS AND CHECKS  ---

  // Deployer repay USDD
  // console.log(`deployer trove debt before repaying: ${await liquityCore.troveManager.getTroveDebt(deployerWallet.address)}`)
  // await mdh.sendAndWaitForTransaction(liquityCore.borrowerOperations.repayUSDD(dec(800, 18), th.ZERO_ADDRESS, th.ZERO_ADDRESS, {gasPrice, gasLimit: 1000000}))
  // console.log(`deployer trove debt after repaying: ${await liquityCore.troveManager.getTroveDebt(deployerWallet.address)}`)

  // Deployer add coll
  // console.log(`deployer trove coll before adding coll: ${await liquityCore.troveManager.getTroveColl(deployerWallet.address)}`)
  // await mdh.sendAndWaitForTransaction(liquityCore.borrowerOperations.addColl(th.ZERO_ADDRESS, th.ZERO_ADDRESS, {value: dec(2, 'ether'), gasPrice, gasLimit: 1000000}))
  // console.log(`deployer trove coll after addingColl: ${await liquityCore.troveManager.getTroveColl(deployerWallet.address)}`)

  // Check chainlink proxy price ---

  const chainlinkProxy = new ethers.Contract(
    configParams.externalAddrs.CHAINLINK_ETHUSD_PROXY,
    ChainlinkAggregatorV3Interface,
    deployerWallet
  );

  // Get latest price
  let chainlinkPrice = await chainlinkProxy.latestAnswer();
  console.log(`current Chainlink price: ${chainlinkPrice}`);

  // Check Tellor price directly (through our TellorCaller)
  // let tellorPriceResponse = await liquityCore.tellorCaller.getTellorCurrentValue(1) // id == 1: the ETH-USD request ID
  // console.log(`current Tellor price: ${tellorPriceResponse[1]}`)
  // console.log(`current Tellor timestamp: ${tellorPriceResponse[2]}`)

  // // Check Uniswap pool has USDD and WETH tokens
  const USDDETHPair = await new ethers.Contract(USDDWETHPairAddr, UniswapV2Pair.abi, deployerWallet);

  // // --- System stats  ---

  // Uniswap USDD-ETH pool size
  reserves = await USDDETHPair.getReserves();
  th.logBN("USDD-ETH Pair's current USDD reserves", reserves[0]);
  th.logBN("USDD-ETH Pair's current ETH reserves", reserves[1]);

  // Number of troves
  const numTroves = await liquityCore.troveManager.getTroveOwnersCount();
  console.log(`number of troves: ${numTroves} `);

  // Sorted list size
  const listSize = await liquityCore.sortedTroves.getSize();
  console.log(`Trove list size: ${listSize} `);

  // Total system debt and coll
  const entireSystemDebt = await liquityCore.troveManager.getEntireSystemDebt();
  const entireSystemColl = await liquityCore.troveManager.getEntireSystemColl();
  th.logBN("Entire system debt", entireSystemDebt);
  th.logBN("Entire system coll", entireSystemColl);

  // TCR
  const TCR = await liquityCore.troveManager.getTCR(chainlinkPrice);
  console.log(`TCR: ${TCR}`);

  // current borrowing rate
  const baseRate = await liquityCore.troveManager.baseRate();
  const currentBorrowingRate = await liquityCore.troveManager.getBorrowingRateWithDecay();
  th.logBN("Base rate", baseRate);
  th.logBN("Current borrowing rate", currentBorrowingRate);

  // total SP deposits
  const totalSPDeposits = await liquityCore.stabilityPool.getTotalUSDDDeposits();
  th.logBN("Total USDD SP deposits", totalSPDeposits);

  // total DEFT Staked in DEFTStaking
  const totalDEFTStaked = await DEFTContracts.deftStaking.totalDEFTStaked();
  th.logBN("Total DEFT staked", totalDEFTStaked);

  // total LP tokens staked in Unipool
  const totalLPTokensStaked = await unipool.totalSupply();
  th.logBN("Total LP (USDD-ETH) tokens staked in unipool", totalLPTokensStaked);

  // --- State variables ---

  // TroveManager
  console.log("TroveManager state variables:");
  const totalStakes = await liquityCore.troveManager.totalStakes();
  const totalStakesSnapshot = await liquityCore.troveManager.totalStakesSnapshot();
  const totalCollateralSnapshot = await liquityCore.troveManager.totalCollateralSnapshot();
  th.logBN("Total trove stakes", totalStakes);
  th.logBN("Snapshot of total trove stakes before last liq. ", totalStakesSnapshot);
  th.logBN("Snapshot of total trove collateral before last liq. ", totalCollateralSnapshot);

  const L_ETH = await liquityCore.troveManager.L_ETH();
  const L_USDDDebt = await liquityCore.troveManager.L_USDDDebt();
  th.logBN("L_ETH", L_ETH);
  th.logBN("L_USDDDebt", L_USDDDebt);

  // StabilityPool
  console.log("StabilityPool state variables:");
  const P = await liquityCore.stabilityPool.P();
  const currentScale = await liquityCore.stabilityPool.currentScale();
  const currentEpoch = await liquityCore.stabilityPool.currentEpoch();
  const S = await liquityCore.stabilityPool.epochToScaleToSum(currentEpoch, currentScale);
  const G = await liquityCore.stabilityPool.epochToScaleToG(currentEpoch, currentScale);
  th.logBN("Product P", P);
  th.logBN("Current epoch", currentEpoch);
  th.logBN("Current scale", currentScale);
  th.logBN("Sum S, at current epoch and scale", S);
  th.logBN("Sum G, at current epoch and scale", G);

  // DEFTStaking
  console.log("DEFTStaking state variables:");
  const F_USDD = await DEFTContracts.deftStaking.F_USDD();
  const F_ETH = await DEFTContracts.deftStaking.F_ETH();
  th.logBN("F_USDD", F_USDD);
  th.logBN("F_ETH", F_ETH);

  // CommunityIssuance
  console.log("CommunityIssuance state variables:");
  const totalDEFTIssued = await DEFTContracts.communityIssuance.totalDEFTIssued();
  th.logBN("Total DEFT issued to depositors / front ends", totalDEFTIssued);
}

module.exports = {
  mainnetDeploy
};
