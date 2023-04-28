const WETHGateway = artifacts.require("./WETHGateway.sol");
const WETH = artifacts.require("./WETH.sol");
const SortedTroves = artifacts.require("./SortedTroves.sol");
const TroveManager = artifacts.require("./TroveManager.sol");
const PriceFeedTestnet = artifacts.require("./PriceFeedTestnet.sol");
const DEFTTokenMock = artifacts.require("ERC20Mock");
const USDDToken = artifacts.require("./USDDToken.sol");
const ActivePool = artifacts.require("./ActivePool.sol");
const DefaultPool = artifacts.require("./DefaultPool.sol");
const StabilityPool = artifacts.require("./StabilityPool.sol");
const GasPool = artifacts.require("./GasPool.sol");
const CollSurplusPool = artifacts.require("./CollSurplusPool.sol");
const FunctionCaller = artifacts.require("./TestContracts/FunctionCaller.sol");
const BorrowerOperations = artifacts.require("./BorrowerOperations.sol");
const HintHelpers = artifacts.require("./HintHelpers.sol");

const DEFTStaking = artifacts.require("./DEFTStaking.sol");
const CommunityIssuance = artifacts.require("./CommunityIssuance.sol");

const Unipool = artifacts.require("./Unipool.sol");

const CommunityIssuanceTester = artifacts.require("./CommunityIssuanceTester.sol");
const StabilityPoolTester = artifacts.require("./StabilityPoolTester.sol");
const ActivePoolTester = artifacts.require("./ActivePoolTester.sol");
const DefaultPoolTester = artifacts.require("./DefaultPoolTester.sol");
const LiquityMathTester = artifacts.require("./LiquityMathTester.sol");
const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol");
const USDDTokenTester = artifacts.require("./USDDTokenTester.sol");

// Proxy scripts
const BorrowerOperationsScript = artifacts.require("BorrowerOperationsScript");
const BorrowerWrappersScript = artifacts.require("BorrowerWrappersScript");
const TroveManagerScript = artifacts.require("TroveManagerScript");
const StabilityPoolScript = artifacts.require("StabilityPoolScript");
const TokenScript = artifacts.require("TokenScript");
const DEFTStakingScript = artifacts.require("DEFTStakingScript");
const {
  buildUserProxies,
  BorrowerOperationsProxy,
  BorrowerWrappersProxy,
  TroveManagerProxy,
  StabilityPoolProxy,
  SortedTrovesProxy,
  TokenProxy,
  DEFTStakingProxy
} = require("../utils/proxyHelpers.js");

const { BNConverter } = require("../utils/BNConverter.js");

/* "Liquity core" consists of all contracts in the core Liquity system.

DEFT contracts consist of only those contracts related to the DEFT Token:

-the DEFT token
-the Lockup factory and lockup contracts
-the DEFTStaking contract
-the CommunityIssuance contract 
*/

const ZERO_ADDRESS = "0x" + "0".repeat(40);
const maxBytes32 = "0x" + "f".repeat(64);

class DeploymentHelper {
  static async deployLiquityCore() {
    const cmdLineArgs = process.argv;
    const frameworkPath = cmdLineArgs[1];
    // console.log(`Framework used:  ${frameworkPath}`)

    if (frameworkPath.includes("hardhat")) {
      return this.deployLiquityCoreHardhat();
    } else if (frameworkPath.includes("truffle")) {
      return this.deployLiquityCoreTruffle();
    }
  }

  static async deployDEFTContracts() {
    const cmdLineArgs = process.argv;
    const frameworkPath = cmdLineArgs[1];
    // console.log(`Framework used:  ${frameworkPath}`)

    if (frameworkPath.includes("hardhat")) {
      return this.deployDEFTContractsHardhat();
    } else if (frameworkPath.includes("truffle")) {
      return this.deployDEFTContractsTruffle();
    }
  }

  static async deployLiquityCoreHardhat() {
    const weth = await WETH.new();
    const priceFeedTestnet = await PriceFeedTestnet.new();
    const sortedTroves = await SortedTroves.new();
    const troveManager = await TroveManager.new();
    const activePool = await ActivePool.new();
    const stabilityPool = await StabilityPool.new();
    const gasPool = await GasPool.new();
    const defaultPool = await DefaultPool.new();
    const collSurplusPool = await CollSurplusPool.new();
    const functionCaller = await FunctionCaller.new();
    const borrowerOperations = await BorrowerOperations.new();
    const hintHelpers = await HintHelpers.new();
    const usddToken = await USDDToken.new(
      troveManager.address,
      stabilityPool.address,
      borrowerOperations.address
    );
    const wETHGateway = await WETHGateway.new(
      borrowerOperations.address,
      troveManager.address,
      stabilityPool.address,
      weth.address
    );
    WETH.setAsDeployed(weth);
    WETHGateway.setAsDeployed(wETHGateway);
    USDDToken.setAsDeployed(usddToken);
    DefaultPool.setAsDeployed(defaultPool);
    PriceFeedTestnet.setAsDeployed(priceFeedTestnet);
    SortedTroves.setAsDeployed(sortedTroves);
    TroveManager.setAsDeployed(troveManager);
    ActivePool.setAsDeployed(activePool);
    StabilityPool.setAsDeployed(stabilityPool);
    GasPool.setAsDeployed(gasPool);
    CollSurplusPool.setAsDeployed(collSurplusPool);
    FunctionCaller.setAsDeployed(functionCaller);
    BorrowerOperations.setAsDeployed(borrowerOperations);
    HintHelpers.setAsDeployed(hintHelpers);

    const coreContracts = {
      weth,
      wETHGateway,
      priceFeedTestnet,
      usddToken,
      sortedTroves,
      troveManager,
      activePool,
      stabilityPool,
      gasPool,
      defaultPool,
      collSurplusPool,
      functionCaller,
      borrowerOperations,
      hintHelpers
    };
    return coreContracts;
  }

  static async deployTesterContractsHardhat() {
    const testerContracts = {};
    testerContracts.weth = await WETH.new();
    // Contract without testers (yet)
    testerContracts.priceFeedTestnet = await PriceFeedTestnet.new();
    testerContracts.sortedTroves = await SortedTroves.new();
    // Actual tester contracts
    testerContracts.communityIssuance = await CommunityIssuanceTester.new();
    testerContracts.activePool = await ActivePoolTester.new();
    testerContracts.defaultPool = await DefaultPoolTester.new();
    testerContracts.stabilityPool = await StabilityPoolTester.new();
    testerContracts.gasPool = await GasPool.new();
    testerContracts.collSurplusPool = await CollSurplusPool.new();
    testerContracts.math = await LiquityMathTester.new();
    testerContracts.borrowerOperations = await BorrowerOperationsTester.new();
    testerContracts.troveManager = await TroveManagerTester.new();
    testerContracts.functionCaller = await FunctionCaller.new();
    testerContracts.hintHelpers = await HintHelpers.new();
    testerContracts.usddToken = await USDDTokenTester.new(
      testerContracts.troveManager.address,
      testerContracts.stabilityPool.address,
      testerContracts.borrowerOperations.address
    );
    testerContracts.wETHGateway = await WETHGateway.new(
      testerContracts.borrowerOperations.address,
      testerContracts.troveManager.address,
      testerContracts.stabilityPool.address,
      testerContracts.weth.address
    );
    return testerContracts;
  }

  static async deployDEFTContractsHardhat() {
    const deftStaking = await DEFTStaking.new();
    const communityIssuance = await CommunityIssuance.new();
    const deftToken = await DEFTTokenMock.new("DEFT", "DEFT");
    DEFTStaking.setAsDeployed(deftStaking);
    CommunityIssuance.setAsDeployed(communityIssuance);

    const DEFTContracts = {
      deftStaking,
      communityIssuance,
      deftToken
    };
    return DEFTContracts;
  }

  static async deployDEFTTesterContractsHardhat() {
    const deftStaking = await DEFTStaking.new();
    const communityIssuance = await CommunityIssuanceTester.new();
    const deftToken = await DEFTTokenMock.new("DEFT", "DEFT");

    DEFTStaking.setAsDeployed(deftStaking);
    CommunityIssuanceTester.setAsDeployed(communityIssuance);

    const DEFTContracts = {
      deftStaking,
      communityIssuance,
      deftToken
    };
    return DEFTContracts;
  }

  static async deployLiquityCoreTruffle() {
    const priceFeedTestnet = await PriceFeedTestnet.new();
    const sortedTroves = await SortedTroves.new();
    const troveManager = await TroveManager.new();
    const activePool = await ActivePool.new();
    const stabilityPool = await StabilityPool.new();
    const gasPool = await GasPool.new();
    const defaultPool = await DefaultPool.new();
    const collSurplusPool = await CollSurplusPool.new();
    const functionCaller = await FunctionCaller.new();
    const borrowerOperations = await BorrowerOperations.new();
    const hintHelpers = await HintHelpers.new();
    const usddToken = await USDDToken.new(
      troveManager.address,
      stabilityPool.address,
      borrowerOperations.address
    );
    const coreContracts = {
      priceFeedTestnet,
      usddToken,
      sortedTroves,
      troveManager,
      activePool,
      stabilityPool,
      gasPool,
      defaultPool,
      collSurplusPool,
      functionCaller,
      borrowerOperations,
      hintHelpers
    };
    return coreContracts;
  }

  static async deployDEFTContractsTruffle() {
    const deftStaking = await deftStaking.new();
    const communityIssuance = await CommunityIssuance.new();
    const deftToken = await DEFTTokenMock.new("DEFT", "DEFT");

    const DEFTContracts = {
      deftStaking,
      communityIssuance,
      deftToken
    };
    return DEFTContracts;
  }

  static async deployUSDDToken(contracts) {
    contracts.usddToken = await USDDToken.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    );
    return contracts;
  }

  static async deployUSDDTokenTester(contracts) {
    contracts.usddToken = await USDDTokenTester.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    );
    return contracts;
  }

  static async deployProxyScripts(contracts, DEFTContracts, owner, users) {
    const proxies = await buildUserProxies(users);

    const borrowerWrappersScript = await BorrowerWrappersScript.new(
      contracts.borrowerOperations.address,
      contracts.troveManager.address,
      DEFTContracts.deftStaking.address
    );
    contracts.borrowerWrappers = new BorrowerWrappersProxy(
      owner,
      proxies,
      borrowerWrappersScript.address
    );

    const borrowerOperationsScript = await BorrowerOperationsScript.new(
      contracts.borrowerOperations.address
    );
    contracts.borrowerOperations = new BorrowerOperationsProxy(
      owner,
      proxies,
      borrowerOperationsScript.address,
      contracts.borrowerOperations
    );

    const troveManagerScript = await TroveManagerScript.new(contracts.troveManager.address);
    contracts.troveManager = new TroveManagerProxy(
      owner,
      proxies,
      troveManagerScript.address,
      contracts.troveManager
    );

    const stabilityPoolScript = await StabilityPoolScript.new(contracts.stabilityPool.address);
    contracts.stabilityPool = new StabilityPoolProxy(
      owner,
      proxies,
      stabilityPoolScript.address,
      contracts.stabilityPool
    );

    contracts.sortedTroves = new SortedTrovesProxy(owner, proxies, contracts.sortedTroves);

    const usddTokenScript = await TokenScript.new(contracts.usddToken.address);
    contracts.usddToken = new TokenProxy(
      owner,
      proxies,
      usddTokenScript.address,
      contracts.usddToken
    );

    const deftTokenScript = await TokenScript.new(DEFTContracts.deftToken.address);
    DEFTContracts.deftToken = new TokenProxy(
      owner,
      proxies,
      deftTokenScript.address,
      DEFTContracts.deftToken
    );

    const deftStakingScript = await DEFTStakingScript.new(DEFTContracts.deftStaking.address);
    DEFTContracts.deftStaking = new DEFTStakingProxy(
      owner,
      proxies,
      deftStakingScript.address,
      DEFTContracts.deftStaking
    );
  }

  // Connect contracts to their dependencies
  static async connectCoreContracts(contracts, DEFTContracts) {
    // set TroveManager addr in SortedTroves
    await contracts.sortedTroves.setParams(
      maxBytes32,
      contracts.troveManager.address,
      contracts.borrowerOperations.address
    );

    // set contract addresses in the FunctionCaller
    await contracts.functionCaller.setTroveManagerAddress(contracts.troveManager.address);
    await contracts.functionCaller.setSortedTrovesAddress(contracts.sortedTroves.address);

    // set contracts in the Trove Manager
    await contracts.troveManager.setAddresses(
      contracts.weth.address,
      contracts.wETHGateway.address,
      contracts.borrowerOperations.address,
      contracts.activePool.address,
      contracts.defaultPool.address,
      contracts.stabilityPool.address,
      contracts.gasPool.address,
      contracts.collSurplusPool.address,
      contracts.priceFeedTestnet.address,
      contracts.usddToken.address,
      contracts.sortedTroves.address,
      DEFTContracts.deftToken.address,
      DEFTContracts.deftStaking.address
    );

    // set contracts in BorrowerOperations
    await contracts.borrowerOperations.setAddresses(
      contracts.weth.address,
      contracts.wETHGateway.address,
      contracts.troveManager.address,
      contracts.activePool.address,
      contracts.defaultPool.address,
      contracts.stabilityPool.address,
      contracts.gasPool.address,
      contracts.collSurplusPool.address,
      contracts.priceFeedTestnet.address,
      contracts.sortedTroves.address,
      contracts.usddToken.address,
      DEFTContracts.deftStaking.address
    );

    // set contracts in the Pools
    await contracts.stabilityPool.setAddresses(
      contracts.weth.address,
      contracts.wETHGateway.address,
      contracts.borrowerOperations.address,
      contracts.troveManager.address,
      contracts.activePool.address,
      contracts.usddToken.address,
      contracts.sortedTroves.address,
      contracts.priceFeedTestnet.address,
      DEFTContracts.communityIssuance.address
    );

    await contracts.activePool.setAddresses(
      [contracts.troveManager.address],
      [contracts.borrowerOperations.address],
      contracts.stabilityPool.address,
      contracts.defaultPool.address
    );

    await contracts.defaultPool.setAddresses(
      [contracts.troveManager.address],
      contracts.activePool.address
    );

    await contracts.collSurplusPool.setAddresses(
      [contracts.weth.address],
      [contracts.troveManager.address],
      [contracts.borrowerOperations.address],
      contracts.activePool.address
    );

    // set contracts in HintHelpers
    await contracts.hintHelpers.setAddresses(
      contracts.sortedTroves.address,
      contracts.troveManager.address
    );
  }

  static async connectDEFTContracts(DEFTContracts) {}

  static async connectDEFTContractsToCore(DEFTContracts, coreContracts) {
    await DEFTContracts.deftStaking.setAddresses(
      [coreContracts.weth.address],
      [coreContracts.troveManager.address],
      [coreContracts.borrowerOperations.address],
      DEFTContracts.deftToken.address,
      coreContracts.usddToken.address,
      coreContracts.activePool.address,
      coreContracts.wETHGateway.address
    );

    await DEFTContracts.communityIssuance.setAddresses(
      DEFTContracts.deftToken.address,
      coreContracts.stabilityPool.address
    );
  }

  static async connectUnipool(uniPool, DEFTContracts, uniswapPairAddr) {
    await uniPool.setAddresses(DEFTContracts.deftToken.address, uniswapPairAddr);
  }
}
module.exports = DeploymentHelper;
