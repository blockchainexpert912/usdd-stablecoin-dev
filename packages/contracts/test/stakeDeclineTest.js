const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol");
const USDDTokenTester = artifacts.require("./USDDTokenTester.sol");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const assertRevert = th.assertRevert;
const mv = testHelpers.MoneyValues;
const timeValues = testHelpers.TimeValues;

/* NOTE: Some tests involving ETH redemption fees do not test for specific fee values.
 * Some only test that the fees are non-zero when they should occur.
 *
 * Specific ETH gain values will depend on the final fee schedule used, and the final choices for
 * the parameter BETA in the TroveManager, which is still TBD based on economic modelling.
 *
 */
contract("TroveManager", async accounts => {
  const ZERO_ADDRESS = th.ZERO_ADDRESS;
  const [owner, A, B, C, D, E, F] = accounts.slice(0, 7);

  let priceFeed;
  let usddToken;
  let sortedTroves;
  let troveManager;
  let activePool;
  let stabilityPool;
  let collSurplusPool;
  let defaultPool;
  let borrowerOperations;
  let hintHelpers;

  let contracts;

  const getOpenTroveUSDDAmount = async totalDebt => th.getOpenTroveUSDDAmount(contracts, totalDebt);
  const openTrove = async params => th.openTrove(contracts, params);
  const adjustTrove = async params => th.adjustTrove(contracts, params);

  const getSnapshotsRatio = async () => {
    const ratio = (await troveManager.totalStakesSnapshot())
      .mul(toBN(dec(1, 18)))
      .div(await troveManager.totalCollateralSnapshot());

    return ratio;
  };

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore();
    contracts.troveManager = await TroveManagerTester.new();
    contracts.usddToken = await USDDTokenTester.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    );
    const DEFTContracts = await deploymentHelper.deployDEFTContracts();

    priceFeed = contracts.priceFeedTestnet;
    usddToken = contracts.usddToken;
    sortedTroves = contracts.sortedTroves;
    troveManager = contracts.troveManager;
    activePool = contracts.activePool;
    stabilityPool = contracts.stabilityPool;
    defaultPool = contracts.defaultPool;
    collSurplusPool = contracts.collSurplusPool;
    borrowerOperations = contracts.borrowerOperations;
    hintHelpers = contracts.hintHelpers;

    deftStaking = DEFTContracts.deftStaking;
    deftToken = DEFTContracts.deftToken;
    communityIssuance = DEFTContracts.communityIssuance;

    await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
    await deploymentHelper.connectDEFTContracts(DEFTContracts);
    await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);
  });

  it("A given trove's stake decline is negligible with adjustments and tiny liquidations", async () => {
    await priceFeed.setPrice(dec(100, 18));

    // Make 1 mega troves A at ~50% total collateral
    await openTrove({
      maxFeePercentage: th._100pct,
      usddAmount: await getOpenTroveUSDDAmount(dec(1, 31)),
      upperHint: ZERO_ADDRESS,
      lowerHint: ZERO_ADDRESS,
      extraParams: { from: A, value: toBN(dec(2, 29)) }
    });

    // Make 5 large troves B, C, D, E, F at ~10% total collateral
    await openTrove({
      maxFeePercentage: th._100pct,
      usddAmount: await getOpenTroveUSDDAmount(dec(2, 30)),
      upperHint: ZERO_ADDRESS,
      lowerHint: ZERO_ADDRESS,
      extraParams: { from: B, value: toBN(dec(4, 28)) }
    });

    await openTrove({
      maxFeePercentage: th._100pct,
      usddAmount: await getOpenTroveUSDDAmount(dec(2, 30)),
      upperHint: ZERO_ADDRESS,
      lowerHint: ZERO_ADDRESS,
      extraParams: { from: C, value: toBN(dec(4, 28)) }
    });

    await openTrove({
      maxFeePercentage: th._100pct,
      usddAmount: await getOpenTroveUSDDAmount(dec(2, 30)),
      upperHint: ZERO_ADDRESS,
      lowerHint: ZERO_ADDRESS,
      extraParams: { from: D, value: toBN(dec(4, 28)) }
    });

    await openTrove({
      maxFeePercentage: th._100pct,
      usddAmount: await getOpenTroveUSDDAmount(dec(2, 30)),
      upperHint: ZERO_ADDRESS,
      lowerHint: ZERO_ADDRESS,
      extraParams: { from: E, value: toBN(dec(4, 28)) }
    });

    await openTrove({
      maxFeePercentage: th._100pct,
      usddAmount: await getOpenTroveUSDDAmount(dec(2, 30)),
      upperHint: ZERO_ADDRESS,
      lowerHint: ZERO_ADDRESS,
      extraParams: { from: F, value: toBN(dec(4, 28)) }
    });

    // Make 10 tiny troves at relatively negligible collateral (~1e-9 of total)
    const tinyTroves = accounts.slice(10, 20);
    for (account of tinyTroves) {
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(1, 22)),
        upperHint: ZERO_ADDRESS,
        lowerHint: ZERO_ADDRESS,
        extraParams: { from: account, value: toBN(dec(2, 20)) }
      });
    }

    // liquidate 1 trove at ~50% total system collateral
    await priceFeed.setPrice(dec(50, 18));
    assert.isTrue(await troveManager.checkRecoveryMode(await priceFeed.getPrice()));
    await troveManager.liquidate(A);

    console.log(`totalStakesSnapshot after L1: ${await troveManager.totalStakesSnapshot()}`);
    console.log(`totalCollateralSnapshot after L1: ${await troveManager.totalCollateralSnapshot()}`);
    console.log(`Snapshots ratio after L1: ${await getSnapshotsRatio()}`);
    console.log(`B pending ETH reward after L1: ${await troveManager.getPendingCollReward(B)}`);
    console.log(`B stake after L1: ${(await troveManager.Troves(B))[2]}`);

    // adjust trove B 1 wei: apply rewards

    await adjustTrove({
      maxFee: th._100pct,
      collDeposited: 0,
      collWithdrawal: 0,
      debtChange: 1,
      isDebtIncrease: false,
      upperHint: ZERO_ADDRESS,
      lowerHint: ZERO_ADDRESS,
      extraParams: {
        from: B
      }
    });

    // B repays 1 wei
    console.log(`B stake after A1: ${(await troveManager.Troves(B))[2]}`);
    console.log(`Snapshots ratio after A1: ${await getSnapshotsRatio()}`);

    // Loop over tiny troves, and alternately:
    // - Liquidate a tiny trove
    // - Adjust B's collateral by 1 wei
    for (let [idx, trove] of tinyTroves.entries()) {
      await troveManager.liquidate(trove);
      console.log(`B stake after L${idx + 2}: ${(await troveManager.Troves(B))[2]}`);
      console.log(`Snapshots ratio after L${idx + 2}: ${await getSnapshotsRatio()}`);
      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: 1,
        isDebtIncrease: false,
        upperHint: ZERO_ADDRESS,
        lowerHint: ZERO_ADDRESS,
        extraParams: {
          from: B
        }
      });
      // A repays 1 wei
      console.log(`B stake after A${idx + 2}: ${(await troveManager.Troves(B))[2]}`);
    }
  });

  // TODO: stake decline for adjustments with sizable liquidations, for comparison
});
