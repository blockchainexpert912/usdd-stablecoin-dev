const deploymentHelper = require("../utils/deploymentHelpers.js");

contract(
  "Deployment script - Sets correct contract addresses dependencies after deployment",
  async accounts => {
    const [owner] = accounts;

    let priceFeed;
    let usddToken;
    let sortedTroves;
    let troveManager;
    let activePool;
    let stabilityPool;
    let defaultPool;
    let functionCaller;
    let borrowerOperations;
    let deftStaking;
    let deftToken;
    let communityIssuance;

    before(async () => {
      const coreContracts = await deploymentHelper.deployLiquityCore();
      const DEFTContracts = await deploymentHelper.deployDEFTContracts();

      priceFeed = coreContracts.priceFeedTestnet;
      usddToken = coreContracts.usddToken;
      sortedTroves = coreContracts.sortedTroves;
      troveManager = coreContracts.troveManager;
      activePool = coreContracts.activePool;
      stabilityPool = coreContracts.stabilityPool;
      defaultPool = coreContracts.defaultPool;
      functionCaller = coreContracts.functionCaller;
      borrowerOperations = coreContracts.borrowerOperations;

      deftStaking = DEFTContracts.deftStaking;
      deftToken = DEFTContracts.deftToken;
      communityIssuance = DEFTContracts.communityIssuance;

      await deploymentHelper.connectDEFTContracts(DEFTContracts);
      await deploymentHelper.connectCoreContracts(coreContracts, DEFTContracts);
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, coreContracts);
    });

    it("Sets the correct PriceFeed address in TroveManager", async () => {
      const priceFeedAddress = priceFeed.address;

      const recordedPriceFeedAddress = await troveManager.priceFeed();

      assert.equal(priceFeedAddress, recordedPriceFeedAddress);
    });

    it("Sets the correct USDDToken address in TroveManager", async () => {
      const usddTokenAddress = usddToken.address;

      const recordedClvTokenAddress = await troveManager.usddToken();

      assert.equal(usddTokenAddress, recordedClvTokenAddress);
    });

    it("Sets the correct SortedTroves address in TroveManager", async () => {
      const sortedTrovesAddress = sortedTroves.address;

      const recordedSortedTrovesAddress = await troveManager.sortedTroves();

      assert.equal(sortedTrovesAddress, recordedSortedTrovesAddress);
    });

    it("Sets the correct BorrowerOperations address in TroveManager", async () => {
      const borrowerOperationsAddress = borrowerOperations.address;

      const recordedBorrowerOperationsAddress = await troveManager.borrowerOperationsAddress();

      assert.equal(borrowerOperationsAddress, recordedBorrowerOperationsAddress);
    });

    // ActivePool in TroveM
    it("Sets the correct ActivePool address in TroveManager", async () => {
      const activePoolAddress = activePool.address;

      const recordedActivePoolAddresss = await troveManager.activePool();

      assert.equal(activePoolAddress, recordedActivePoolAddresss);
    });

    // DefaultPool in TroveM
    it("Sets the correct DefaultPool address in TroveManager", async () => {
      const defaultPoolAddress = defaultPool.address;

      const recordedDefaultPoolAddresss = await troveManager.defaultPool();

      assert.equal(defaultPoolAddress, recordedDefaultPoolAddresss);
    });

    // StabilityPool in TroveM
    it("Sets the correct StabilityPool address in TroveManager", async () => {
      const stabilityPoolAddress = stabilityPool.address;

      const recordedStabilityPoolAddresss = await troveManager.stabilityPool();

      assert.equal(stabilityPoolAddress, recordedStabilityPoolAddresss);
    });

    // DEFT Staking in TroveM
    it("Sets the correct DEFTStaking address in TroveManager", async () => {
      const deftStakingAddress = deftStaking.address;

      const recordedDEFTStakingAddress = await troveManager.deftStaking();
      assert.equal(deftStakingAddress, recordedDEFTStakingAddress);
    });

    // Active Pool

    it("Sets the correct StabilityPool address in ActivePool", async () => {
      const stabilityPoolAddress = stabilityPool.address;

      const recordedStabilityPoolAddress = await activePool.stabilityPoolAddress();

      assert.equal(stabilityPoolAddress, recordedStabilityPoolAddress);
    });

    it("Sets the correct DefaultPool address in ActivePool", async () => {
      const defaultPoolAddress = defaultPool.address;

      const recordedDefaultPoolAddress = await activePool.defaultPoolAddress();

      assert.equal(defaultPoolAddress, recordedDefaultPoolAddress);
    });

    it("Sets the correct BorrowerOperations address in ActivePool", async () => {
      const borrowerOperationsAddress = borrowerOperations.address;
      assert.isTrue(await activePool.authorizedBorrowerOperations(borrowerOperationsAddress));
    });

    it("Sets the correct TroveManager address in ActivePool", async () => {
      const troveManagerAddress = troveManager.address;

      assert.isTrue(await activePool.authorizedTroveManagers(troveManagerAddress));
    });

    // Stability Pool

    it("Sets the correct ActivePool address in StabilityPool", async () => {
      const activePoolAddress = activePool.address;

      const recordedActivePoolAddress = await stabilityPool.activePool();
      assert.equal(activePoolAddress, recordedActivePoolAddress);
    });

    it("Sets the correct BorrowerOperations address in StabilityPool", async () => {
      const borrowerOperationsAddress = borrowerOperations.address;

      const recordedBorrowerOperationsAddress = await stabilityPool.borrowerOperations();

      assert.equal(borrowerOperationsAddress, recordedBorrowerOperationsAddress);
    });

    it("Sets the correct USDDToken address in StabilityPool", async () => {
      const usddTokenAddress = usddToken.address;

      const recordedClvTokenAddress = await stabilityPool.usddToken();

      assert.equal(usddTokenAddress, recordedClvTokenAddress);
    });

    it("Sets the correct TroveManager address in StabilityPool", async () => {
      const troveManagerAddress = troveManager.address;

      const recordedTroveManagerAddress = await stabilityPool.troveManager();
      assert.equal(troveManagerAddress, recordedTroveManagerAddress);
    });

    // Default Pool

    it("Sets the correct TroveManager address in DefaultPool", async () => {
      const troveManagerAddress = troveManager.address;

      assert.isTrue(await defaultPool.authorizedTroveManagers(troveManagerAddress));
    });

    it("Sets the correct ActivePool address in DefaultPool", async () => {
      const activePoolAddress = activePool.address;

      const recordedActivePoolAddress = await defaultPool.activePoolAddress();
      assert.equal(activePoolAddress, recordedActivePoolAddress);
    });

    it("Sets the correct TroveManager address in SortedTroves", async () => {
      const borrowerOperationsAddress = borrowerOperations.address;

      const recordedBorrowerOperationsAddress = await sortedTroves.borrowerOperationsAddress();
      assert.equal(borrowerOperationsAddress, recordedBorrowerOperationsAddress);
    });

    it("Sets the correct BorrowerOperations address in SortedTroves", async () => {
      const troveManagerAddress = troveManager.address;

      const recordedTroveManagerAddress = await sortedTroves.troveManager();
      assert.equal(troveManagerAddress, recordedTroveManagerAddress);
    });

    //--- BorrowerOperations ---

    // TroveManager in BO
    it("Sets the correct TroveManager address in BorrowerOperations", async () => {
      const troveManagerAddress = troveManager.address;

      const recordedTroveManagerAddress = await borrowerOperations.troveManager();
      assert.equal(troveManagerAddress, recordedTroveManagerAddress);
    });

    // setPriceFeed in BO
    it("Sets the correct PriceFeed address in BorrowerOperations", async () => {
      const priceFeedAddress = priceFeed.address;

      const recordedPriceFeedAddress = await borrowerOperations.priceFeed();
      assert.equal(priceFeedAddress, recordedPriceFeedAddress);
    });

    // setSortedTroves in BO
    it("Sets the correct SortedTroves address in BorrowerOperations", async () => {
      const sortedTrovesAddress = sortedTroves.address;

      const recordedSortedTrovesAddress = await borrowerOperations.sortedTroves();
      assert.equal(sortedTrovesAddress, recordedSortedTrovesAddress);
    });

    // setActivePool in BO
    it("Sets the correct ActivePool address in BorrowerOperations", async () => {
      const activePoolAddress = activePool.address;

      const recordedActivePoolAddress = await borrowerOperations.activePool();
      assert.equal(activePoolAddress, recordedActivePoolAddress);
    });

    // setDefaultPool in BO
    it("Sets the correct DefaultPool address in BorrowerOperations", async () => {
      const defaultPoolAddress = defaultPool.address;

      const recordedDefaultPoolAddress = await borrowerOperations.defaultPool();
      assert.equal(defaultPoolAddress, recordedDefaultPoolAddress);
    });

    // DEFT Staking in BO
    it("Sets the correct DEFTStaking address in BorrowerOperations", async () => {
      const deftStakingAddress = deftStaking.address;

      const recordedDEFTStakingAddress = await borrowerOperations.deftStakingAddress();
      assert.equal(deftStakingAddress, recordedDEFTStakingAddress);
    });

    // --- DEFT Staking ---

    // Sets DEFTToken in DEFTStaking
    it("Sets the correct DEFTToken address in DEFTStaking", async () => {
      const deftTokenAddress = deftToken.address;

      const recordedDEFTTokenAddress = await deftStaking.deftToken();
      assert.equal(deftTokenAddress, recordedDEFTTokenAddress);
    });

    // Sets ActivePool in DEFTStaking
    it("Sets the correct ActivePool address in DEFTStaking", async () => {
      const activePoolAddress = activePool.address;

      const recordedActivePoolAddress = await deftStaking.activePoolAddress();
      assert.equal(activePoolAddress, recordedActivePoolAddress);
    });

    // Sets USDDToken in DEFTStaking
    it("Sets the correct ActivePool address in DEFTStaking", async () => {
      const usddTokenAddress = usddToken.address;

      const recordedUSDDTokenAddress = await deftStaking.usddToken();
      assert.equal(usddTokenAddress, recordedUSDDTokenAddress);
    });

    // Sets TroveManager in DEFTStaking
    it("Sets the correct ActivePool address in DEFTStaking", async () => {
      assert.isTrue(await deftStaking.authorizedTroveManagers(troveManager.address));
    });

    // Sets BorrowerOperations in DEFTStaking
    it("Sets the correct BorrowerOperations address in DEFTStaking", async () => {
      assert.isTrue(await deftStaking.authorizedBorrowerOperations(borrowerOperations.address));
    });

    // --- CI ---

    // Sets DEFTToken in CommunityIssuance
    it("Sets the correct DEFTToken address in CommunityIssuance", async () => {
      const deftTokenAddress = deftToken.address;

      const recordedDEFTTokenAddress = await communityIssuance.deftToken();
      assert.equal(deftTokenAddress, recordedDEFTTokenAddress);
    });

    it("Sets the correct StabilityPool address in CommunityIssuance", async () => {
      const stabilityPoolAddress = stabilityPool.address;

      const recordedStabilityPoolAddress = await communityIssuance.stabilityPoolAddress();
      assert.equal(stabilityPoolAddress, recordedStabilityPoolAddress);
    });
  }
);
