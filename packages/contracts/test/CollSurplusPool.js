const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");
const NonPayable = artifacts.require("NonPayable.sol");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const mv = testHelpers.MoneyValues;
const timeValues = testHelpers.TimeValues;

const TroveManagerTester = artifacts.require("TroveManagerTester");
const USDDToken = artifacts.require("USDDToken");

contract("CollSurplusPool", async accounts => {
  const [owner, A, B, C, D, E] = accounts;

  let borrowerOperations;
  let priceFeed;
  let collSurplusPool;
  let collToken;

  let contracts;

  const getOpenTroveUSDDAmount = async totalDebt => th.getOpenTroveUSDDAmount(contracts, totalDebt);
  const openTrove = async params => th.openTrove(contracts, params);

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore();
    contracts.troveManager = await TroveManagerTester.new();
    contracts.usddToken = await USDDToken.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    );
    const DEFTContracts = await deploymentHelper.deployDEFTContracts();

    priceFeed = contracts.priceFeedTestnet;
    collSurplusPool = contracts.collSurplusPool;
    borrowerOperations = contracts.borrowerOperations;
    collToken = contracts.weth;

    await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
    await deploymentHelper.connectDEFTContracts(DEFTContracts);
    await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);
  });

  it("CollSurplusPool::getColl(): Returns the ETH balance of the CollSurplusPool after redemption", async () => {
    const ETH_1 = await collSurplusPool.getColl(collToken.address);
    assert.equal(ETH_1, "0");

    const price = toBN(dec(100, 18));
    await priceFeed.setPrice(price);

    const { collateral: B_coll, netDebt: B_netDebt } = await openTrove({
      ICR: toBN(dec(200, 16)),
      extraParams: { from: B }
    });
    await openTrove({
      extraUSDDAmount: B_netDebt,
      extraParams: { from: A, value: toBN(dec(3000, "ether")) }
    });

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // At ETH:USD = 100, this redemption should leave 1 ether of coll surplus
    await th.redeemCollateralAndGetTxObject(A, contracts, B_netDebt);

    const ETH_2 = await collSurplusPool.getColl(collToken.address);
    th.assertIsApproximatelyEqual(ETH_2, B_coll.sub(B_netDebt.mul(mv._1e18BN).div(price)));
  });

  it("CollSurplusPool: claimColl(): Reverts if caller is not Borrower Operations", async () => {
    await th.assertRevert(
      collSurplusPool.claimColl(A, A, collToken.address, { from: A }),
      "CollSurplusPool: Caller is not Borrower Operations"
    );
  });

  it("CollSurplusPool: claimColl(): Reverts if nothing to claim", async () => {
    await th.assertRevert(
      borrowerOperations.claimCollateral({ from: A }),
      "CollSurplusPool: No collateral available to claim"
    );
  });

  // it("CollSurplusPool: claimColl(): Reverts if owner cannot receive ETH surplus", async () => {
  //   const nonPayable = await NonPayable.new();

  //   const price = toBN(dec(100, 18));
  //   await priceFeed.setPrice(price);

  //   // open trove from NonPayable proxy contract
  //   const B_coll = toBN(dec(60, 18));
  //   const B_usddAmount = toBN(dec(3000, 18));
  //   const B_netDebt = await th.getAmountWithBorrowingFee(contracts, B_usddAmount);
  //   const openTroveData = th.getTransactionData("openTrove(uint256,uint256,address,address)", [
  //     "0xde0b6b3a7640000",
  //     web3.utils.toHex(B_usddAmount),
  //     B,
  //     B
  //   ]);
  //   await nonPayable.forward(borrowerOperations.address, openTroveData, { value: B_coll });
  //   await openTrove({
  //     extraUSDDAmount: B_netDebt,
  //     extraParams: { from: A, value: toBN(dec(3000, "ether")) }
  //   });

  //   // skip bootstrapping phase
  //   await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

  //   // At ETH:USD = 100, this redemption should leave 1 ether of coll surplus for B
  //   await th.redeemCollateralAndGetTxObject(A, contracts, B_netDebt);

  //   const ETH_2 = await collSurplusPool.getColl(collToken.address);
  //   th.assertIsApproximatelyEqual(ETH_2, B_coll.sub(B_netDebt.mul(mv._1e18BN).div(price)));

  //   const claimCollateralData = th.getTransactionData("claimCollateral()", []);
  //   await th.assertRevert(
  //     nonPayable.forward(borrowerOperations.address, claimCollateralData),
  //     "CollSurplusPool: sending ETH failed"
  //   );
  // });

  it("CollSurplusPool: reverts trying to send ETH to it", async () => {
    await th.assertRevert(
      web3.eth.sendTransaction({ from: A, to: collSurplusPool.address, value: 1 }),
      "CollSurplusPool: Caller is not Active Pool"
    );
  });

  it("CollSurplusPool: accountSurplus: reverts if caller is not Trove Manager", async () => {
    await th.assertRevert(
      collSurplusPool.accountSurplus(A, collToken.address, 1),
      "CollSurplusPool: Caller is not TroveManager"
    );
  });
});

contract("Reset chain state", async accounts => {});
