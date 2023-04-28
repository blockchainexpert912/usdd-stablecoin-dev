const StabilityPool = artifacts.require("./StabilityPool.sol");
const ActivePool = artifacts.require("./ActivePoolTester.sol");
const DefaultPool = artifacts.require("./DefaultPoolTester.sol");
const NonPayable = artifacts.require("./NonPayable.sol");
const BorrowerOperations = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManager = artifacts.require("./TroveManagerTester.sol");
const WETH = artifacts.require("./WETH.sol");

const testHelpers = require("../utils/testHelpers.js");

const th = testHelpers.TestHelper;
const dec = th.dec;

const _minus_1_Ether = web3.utils.toWei("-1", "ether");

contract("StabilityPool", async accounts => {
  /* mock* are EOA’s, temporarily used to call protected functions.
  TODO: Replace with mock contracts, and later complete transactions from EOA
  */
  let stabilityPool;
  let collToken;

  const [owner, alice] = accounts;

  beforeEach(async () => {
    collToken = await WETH.new();
    stabilityPool = await StabilityPool.new();
    const dumbContractAddress = (await NonPayable.new()).address;
    await stabilityPool.setAddresses(
      collToken.address,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress
    );
  });

  it("getColl(): gets the recorded ETH balance", async () => {
    const recordedETHBalance = await stabilityPool.getColl();
    assert.equal(recordedETHBalance, 0);
  });

  it("getTotalUSDDDeposits(): gets the recorded USDD balance", async () => {
    const recordedETHBalance = await stabilityPool.getTotalUSDDDeposits();
    assert.equal(recordedETHBalance, 0);
  });
});

contract("ActivePool", async accounts => {
  let activePool, borrowerOperations, collToken;

  const [owner, alice] = accounts;
  beforeEach(async () => {
    activePool = await ActivePool.new();
    collToken = await WETH.new();
    borrowerOperations = await BorrowerOperations.new();
    const dumbContractAddress = (await NonPayable.new()).address;
    await activePool.setAddresses(
      [dumbContractAddress],
      [borrowerOperations.address],
      dumbContractAddress,
      dumbContractAddress
    );
    await borrowerOperations.setAddresses(
      collToken.address,
      dumbContractAddress,
      dumbContractAddress,
      activePool.address,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress
    );
  });

  it("getColl(): gets the recorded ETH balance", async () => {
    const recordedETHBalance = await activePool.getColl(collToken.address);
    assert.equal(recordedETHBalance, 0);
  });

  it("getUSDDDebt(): gets the recorded USDD balance", async () => {
    const recordedETHBalance = await activePool.getUSDDDebt();
    assert.equal(recordedETHBalance, 0);
  });

  it("increaseUSDD(): increases the recorded USDD balance by the correct amount", async () => {
    const recordedUSDD_balanceBefore = await activePool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceBefore, 0);

    // await activePool.increaseUSDDDebt(100, { from: borrowerOperationsAddress })
    const increaseUSDDDebtData = th.getTransactionData("increaseUSDDDebt(uint256)", ["0x64"]);
    const tx = await borrowerOperations.forward(activePool.address, increaseUSDDDebtData);
    assert.isTrue(tx.receipt.status);
    const recordedUSDD_balanceAfter = await activePool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceAfter, 100);
  });
  // Decrease
  it("decreaseUSDD(): decreases the recorded USDD balance by the correct amount", async () => {
    // start the pool on 100 wei
    //await activePool.increaseUSDDDebt(100, { from: borrowerOperationsAddress })
    const increaseUSDDDebtData = th.getTransactionData("increaseUSDDDebt(uint256)", ["0x64"]);
    const tx1 = await borrowerOperations.forward(activePool.address, increaseUSDDDebtData);
    assert.isTrue(tx1.receipt.status);

    const recordedUSDD_balanceBefore = await activePool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceBefore, 100);

    //await activePool.decreaseUSDDDebt(100, { from: borrowerOperationsAddress })
    const decreaseUSDDDebtData = th.getTransactionData("decreaseUSDDDebt(uint256)", ["0x64"]);
    const tx2 = await borrowerOperations.forward(activePool.address, decreaseUSDDDebtData);
    assert.isTrue(tx2.receipt.status);
    const recordedUSDD_balanceAfter = await activePool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceAfter, 0);
  });

  // send raw ether
  it("sendColl(): decreases the recorded ETH balance by the correct amount", async () => {
    // setup: give pool 2 ether
    const activePool_initialBalance = web3.utils.toBN(await collToken.balanceOf(activePool.address));
    assert.equal(activePool_initialBalance, 0);
    // start pool with 2 ether
    //await web3.eth.sendTransaction({ from: borrowerOperationsAddress, to: activePool.address, value: dec(2, 'ether') })

    await borrowerOperations.forward(collToken.address, "0x", {
      from: owner,
      value: dec(2, "ether")
    });
    const receiveCollData = th.getTransactionData("receiveColl(address,uint256)", [
      collToken.address,
      dec(2, "ether")
    ]);

    const tx1 = await borrowerOperations.forward(activePool.address, receiveCollData, {
      from: owner
    });

    assert.isTrue(tx1.receipt.status);

    const activePool_BalanceBeforeTx = web3.utils.toBN(
      await collToken.balanceOf(activePool.address)
    );
    const alice_Balance_BeforeTx = web3.utils.toBN(await collToken.balanceOf(alice));

    assert.equal(activePool_BalanceBeforeTx, dec(2, "ether"));

    // send ether from pool to alice
    //await activePool.sendColl(alice, dec(1, 'ether'), { from: borrowerOperationsAddress })
    const sendCollData = th.getTransactionData("sendColl(address,address,uint256)", [
      alice,
      collToken.address,
      web3.utils.toHex(dec(1, "ether"))
    ]);
    const tx2 = await borrowerOperations.forward(activePool.address, sendCollData, {
      from: owner
    });
    assert.isTrue(tx2.receipt.status);

    const activePool_BalanceAfterTx = web3.utils.toBN(await collToken.balanceOf(activePool.address));
    const alice_Balance_AfterTx = web3.utils.toBN(await collToken.balanceOf(alice));

    const alice_BalanceChange = alice_Balance_AfterTx.sub(alice_Balance_BeforeTx);
    const pool_BalanceChange = activePool_BalanceAfterTx.sub(activePool_BalanceBeforeTx);
    assert.equal(alice_BalanceChange, dec(1, "ether"));
    assert.equal(pool_BalanceChange, _minus_1_Ether);
  });
});

contract("DefaultPool", async accounts => {
  let defaultPool, troveManager, collToken, activePool;

  const [owner, alice] = accounts;
  beforeEach(async () => {
    collToken = await WETH.new();
    activePool = await ActivePool.new();
    defaultPool = await DefaultPool.new();
    troveManager = await TroveManager.new();
    const dumbContractAddress = (await NonPayable.new()).address;

    await activePool.setAddresses(
      [dumbContractAddress],
      [dumbContractAddress],
      dumbContractAddress,
      defaultPool.address
    );

    troveManager.setAddresses(
      collToken.address,
      dumbContractAddress,
      dumbContractAddress,
      activePool.address,
      defaultPool.address,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress,
      dumbContractAddress
    );
    await defaultPool.setAddresses([troveManager.address], activePool.address);
  });

  it("getColl(): gets the recorded USDD balance", async () => {
    const recordedETHBalance = await defaultPool.getColl(collToken.address);
    assert.equal(recordedETHBalance, 0);
  });

  it("getUSDDDebt(): gets the recorded USDD balance", async () => {
    const recordedETHBalance = await defaultPool.getUSDDDebt();
    assert.equal(recordedETHBalance, 0);
  });

  it("increaseUSDD(): increases the recorded USDD balance by the correct amount", async () => {
    const recordedUSDD_balanceBefore = await defaultPool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceBefore, 0);

    // await defaultPool.increaseUSDDDebt(100, { from: troveManagerAddress })
    const increaseUSDDDebtData = th.getTransactionData("increaseUSDDDebt(uint256)", ["0x64"]);
    const tx = await troveManager.forward(defaultPool.address, increaseUSDDDebtData);
    assert.isTrue(tx.receipt.status);

    const recordedUSDD_balanceAfter = await defaultPool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceAfter, 100);
  });

  it("decreaseUSDD(): decreases the recorded USDD balance by the correct amount", async () => {
    // start the pool on 100 wei
    //await defaultPool.increaseUSDDDebt(100, { from: troveManagerAddress })
    const increaseUSDDDebtData = th.getTransactionData("increaseUSDDDebt(uint256)", ["0x64"]);
    const tx1 = await troveManager.forward(defaultPool.address, increaseUSDDDebtData);
    assert.isTrue(tx1.receipt.status);

    const recordedUSDD_balanceBefore = await defaultPool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceBefore, 100);

    // await defaultPool.decreaseUSDDDebt(100, { from: troveManagerAddress })
    const decreaseUSDDDebtData = th.getTransactionData("decreaseUSDDDebt(uint256)", ["0x64"]);
    const tx2 = await troveManager.forward(defaultPool.address, decreaseUSDDDebtData);
    assert.isTrue(tx2.receipt.status);

    const recordedUSDD_balanceAfter = await defaultPool.getUSDDDebt();
    assert.equal(recordedUSDD_balanceAfter, 0);
  });

  // send raw ether
  it("sendToActivePool(): decreases the recorded ETH balance by the correct amount", async () => {
    // setup: give pool 2 ether
    const defaultPool_initialBalance = web3.utils.toBN(
      await collToken.balanceOf(defaultPool.address)
    );
    assert.equal(defaultPool_initialBalance, 0);

    // start pool with 2 ether
    //await web3.eth.sendTransaction({ from: activePool.address, to: defaultPool.address, value: dec(2, 'ether') })

    await troveManager.forward(collToken.address, "0x", {
      from: owner,
      value: dec(2, "ether")
    });

    const recieveCollData = th.getTransactionData("receiveColl(address,uint256)", [
      collToken.address,
      web3.utils.toHex(dec(2, "ether"))
    ]);

    await troveManager.forward(defaultPool.address, recieveCollData, { from: owner });

    const defaultPool_BalanceBeforeTx = web3.utils.toBN(
      await collToken.balanceOf(defaultPool.address)
    );
    const activePool_Balance_BeforeTx = web3.utils.toBN(
      await collToken.balanceOf(activePool.address)
    );

    assert.equal(defaultPool_BalanceBeforeTx, dec(2, "ether"));
    assert.equal(activePool_Balance_BeforeTx, 0);

    // send ether from pool to alice
    //await defaultPool.sendToActivePool(dec(1, 'ether'), { from: troveManagerAddress })
    const sendETHData = th.getTransactionData("sendToActivePool(address,uint256)", [
      collToken.address,
      web3.utils.toHex(dec(1, "ether"))
    ]);
    const tx2 = await troveManager.forward(defaultPool.address, sendETHData, { from: owner });
    assert.isTrue(tx2.receipt.status);

    const defaultPool_BalanceAfterTx = web3.utils.toBN(
      await collToken.balanceOf(defaultPool.address)
    );
    const activePool_Balance_AfterTx = web3.utils.toBN(
      await collToken.balanceOf(activePool.address)
    );

    const activePool_BalanceChange = activePool_Balance_AfterTx.sub(activePool_Balance_BeforeTx);
    const defaultPool_BalanceChange = defaultPool_BalanceAfterTx.sub(defaultPool_BalanceBeforeTx);
    assert.equal(activePool_BalanceChange, dec(1, "ether"));
    assert.equal(defaultPool_BalanceChange, _minus_1_Ether);
  });
});

contract("Reset chain state", async accounts => {});
