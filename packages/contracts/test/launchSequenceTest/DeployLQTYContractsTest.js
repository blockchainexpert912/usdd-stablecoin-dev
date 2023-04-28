const deploymentHelper = require("../../utils/deploymentHelpers.js");
const testHelpers = require("../../utils/testHelpers.js");
const CommunityIssuance = artifacts.require("./CommunityIssuance.sol");
const ERC20Mock = artifacts.require("./TestContracts/ERC20Mock.sol");

const th = testHelpers.TestHelper;
const timeValues = testHelpers.TimeValues;
const assertRevert = th.assertRevert;
const toBN = th.toBN;
const dec = th.dec;

contract("Deploying the DEFT contracts: CI, DEFTStaking, and DEFTToken ", async accounts => {
  const [liquityAG, A, B] = accounts;

  let DEFTContracts;

  const oneMillion = toBN(1000000);
  const digits = toBN(1e18);
  const thirtyTwo = toBN(32);
  const expectedCISupplyCap = thirtyTwo.mul(oneMillion).mul(digits);

  beforeEach(async () => {
    // Deploy all contracts from the first account
    DEFTContracts = await deploymentHelper.deployDEFTTesterContractsHardhat();
    await deploymentHelper.connectDEFTContracts(DEFTContracts);

    deftStaking = DEFTContracts.deftStaking;
    deftToken = DEFTContracts.deftToken;
    communityIssuance = DEFTContracts.communityIssuance;

    //DEFT Staking and CommunityIssuance have not yet had their setters called, so are not yet
    // connected to the rest of the system
  });

  describe("CommunityIssuance deployment", async accounts => {
    it("Stores the deployer's address", async () => {
      const storedDeployerAddress = await communityIssuance.owner();

      assert.equal(liquityAG, storedDeployerAddress);
    });
  });

  describe("DEFTStaking deployment", async accounts => {
    it("Stores the deployer's address", async () => {
      const storedDeployerAddress = await deftStaking.owner();

      assert.equal(liquityAG, storedDeployerAddress);
    });
  });

  describe("Community Issuance deployment", async accounts => {
    it("Stores the deployer's address", async () => {
      const storedDeployerAddress = await communityIssuance.owner();

      assert.equal(storedDeployerAddress, liquityAG);
    });
  });

  describe("Connecting DEFTToken to CI and DEFTStaking", async accounts => {
    it("sets the correct DEFTToken address in DEFTStaking", async () => {
      // Deploy core contracts and set the DEFTToken address in the CI and DEFTStaking
      const coreContracts = await deploymentHelper.deployLiquityCore();
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, coreContracts);

      const deftTokenAddress = deftToken.address;

      const recordedDEFTTokenAddress = await deftStaking.deftToken();
      assert.equal(deftTokenAddress, recordedDEFTTokenAddress);
    });

    it("sets the correct DEFTToken address in CommunityIssuance", async () => {
      // Deploy core contracts and set the DEFTToken address in the CI and DEFTStaking
      const coreContracts = await deploymentHelper.deployLiquityCore();
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, coreContracts);

      const deftTokenAddress = deftToken.address;

      const recordedDEFTTokenAddress = await communityIssuance.deftToken();
      assert.equal(deftTokenAddress, recordedDEFTTokenAddress);
    });
  });
});
