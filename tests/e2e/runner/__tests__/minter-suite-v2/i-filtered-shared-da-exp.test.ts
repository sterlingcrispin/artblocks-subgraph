import { describe, test, expect } from "@jest/globals";
import {
  getSubgraphConfig,
  createSubgraphClient,
  getAccounts,
  waitUntilSubgraphIsSynced,
  getMinterDetails,
  getProjectMinterConfigurationDetails,
} from "../utils/helpers";

import { MinterFilterV2__factory } from "../../contracts/factories/MinterFilterV2__factory";
import { MinterDAExpV5__factory } from "../../contracts/factories/MinterDAExpV5__factory";

import { ethers } from "ethers";
// hide nuisance logs about event overloading
import { Logger } from "@ethersproject/logger";
Logger.setLogLevel(Logger.levels.ERROR);

// waiting for subgraph to sync can take longer than the default 5s timeout
jest.setTimeout(30 * 1000);

const config = getSubgraphConfig();

const client = createSubgraphClient();
const { deployer, artist } = getAccounts();

// set up delegation registry address
const delegationRegistryAddress = config.metadata?.delegationRegistryAddress;
if (!delegationRegistryAddress)
  throw new Error("No delegation registry address found in config metadata");

// set up contract instances and/or addresses
const coreRegistryAddress = config.metadata?.coreRegistryAddress;
if (!coreRegistryAddress)
  throw new Error("No core registry address found in config metadata");

const sharedMinterFilter = config.sharedMinterFilterContracts?.[0];
if (!sharedMinterFilter) {
  throw new Error("No shared minter filter found in config metadata");
}
const sharedMinterFilterContract = new MinterFilterV2__factory(deployer).attach(
  sharedMinterFilter.address
);

// get contract from the subgraph config
if (!config.iGenArt721CoreContractV3_BaseContracts) {
  throw new Error("No iGenArt721CoreContractV3_BaseContracts in config");
}
const genArt721CoreAddress =
  config.iGenArt721CoreContractV3_BaseContracts[0].address;

// get MinterDAExp contract from the subgraph config
if (!config.iSharedDAExpContracts) {
  throw new Error("No iSharedDAExpContracts in config");
}
const minterDAExpV5Address = config.iSharedDAExpContracts[0].address;
const minterDAExpV5Contract = new MinterDAExpV5__factory(deployer).attach(
  minterDAExpV5Address
);

// helper function to calculate approximate DAExp length
function getApproxDAExpLength(
  startPrice: ethers.BigNumber,
  basePrice: ethers.BigNumber,
  halfLifeSeconds: number
): number {
  const EXTRA_DECIMALS = 10 ** 5;
  // const startPriceFloatingPoint = ethers.utils.parseUnits(startPrice);
  // const basePriceFloatingPoint = basePrice.toBigDecimal();
  const priceRatio =
    startPrice.mul(EXTRA_DECIMALS).div(basePrice).toNumber() / EXTRA_DECIMALS;
  const completedHalfLives = Math.floor(Math.log(priceRatio) / Math.log(2));
  const x1 = completedHalfLives * halfLifeSeconds;
  const x2 = x1 + halfLifeSeconds;
  const y1 = startPrice.div(2 ** completedHalfLives);
  const y2 = y1.div(2);
  const totalAuctionTime =
    x1 +
    (x2 - x1) *
      (basePrice.sub(y1).mul(EXTRA_DECIMALS).div(y2.sub(y1)).toNumber() /
        EXTRA_DECIMALS);
  return totalAuctionTime;
}

describe("iFilteredSharedDAExp event handling", () => {
  beforeAll(async () => {
    await waitUntilSubgraphIsSynced(client);
  });

  describe("Indexed after setup", () => {
    test("created new Minter during deployment and allowlisting", async () => {
      const targetId = minterDAExpV5Address.toLowerCase();
      const minterRes = await getMinterDetails(client, targetId);
      expect(minterRes.id).toBe(targetId);
    });
  });

  describe("AuctionMinHalfLifeSecondsUpdated", () => {
    // @dev no need to reset the affected value after each test
    test("updated after admin configures", async () => {
      // query public constant for the expected value (>0)
      const initialValue =
        await minterDAExpV5Contract.minimumPriceDecayHalfLifeSeconds();
      const newTargetValue = initialValue.add(1);
      // update the minter value
      await minterDAExpV5Contract
        .connect(deployer)
        .setMinimumPriceDecayHalfLifeSeconds(newTargetValue);
      // validate minter's extraMinterDetails in subgraph
      await waitUntilSubgraphIsSynced(client);
      const targetId = minterDAExpV5Address.toLowerCase();
      const minterRes = await getMinterDetails(client, targetId);
      const extraMinterDetails = JSON.parse(minterRes.extraMinterDetails);
      expect(extraMinterDetails.minimumHalfLifeInSeconds).toBe(
        newTargetValue.toNumber()
      );
    });
  });

  describe("SetAuctionDetailsExp", () => {
    afterEach(async () => {
      // clear the auction details for the project
      await minterDAExpV5Contract
        .connect(deployer)
        .resetAuctionDetails(0, genArt721CoreAddress);
      // clear the current minter for the project
      // @dev call success depends on test state, so use a try/catch block
      try {
        await sharedMinterFilterContract
          .connect(artist)
          .removeMinterForProject(0, genArt721CoreAddress);
      } catch (error) {
        // try block will only fail in case of previously failed test where
        // project zero never had its minter assigned.
        // Thus, swallow error here because the test failure has already been
        // reported, and additional error messaging from afterEach is not
        // helpful.
      }
    });

    test("subgraph is updated after event emitted", async () => {
      // artist configures auction
      await sharedMinterFilterContract.connect(artist).setMinterForProject(
        0, // _projectId
        genArt721CoreAddress, // _coreContract
        minterDAExpV5Address // _minter
      );
      const latestBlock = await deployer.provider.getBlock("latest");
      const targetAuctionStart = latestBlock.timestamp + 3600;
      const targetStartPrice = ethers.utils.parseEther("1");
      const targetBasePrice = ethers.utils.parseEther("0.1");
      await minterDAExpV5Contract.connect(artist).setAuctionDetails(
        0, // _projectId
        genArt721CoreAddress, // _coreContract
        targetAuctionStart, // _timestampStart
        600, // _priceDecayHalfLifeSeconds
        targetStartPrice, // _startPrice
        targetBasePrice // _basePrice
      );
      // validate project minter config in subgraph
      await waitUntilSubgraphIsSynced(client);
      const targetId = `${minterDAExpV5Address.toLowerCase()}-${genArt721CoreAddress.toLowerCase()}-0`;
      const minterConfigRes = await getProjectMinterConfigurationDetails(
        client,
        targetId
      );
      // validate fields
      expect(minterConfigRes.priceIsConfigured).toBe(true);
      expect(minterConfigRes.basePrice).toBe(targetBasePrice.toString());
      // validate extraMinterDetails
      const extraMinterDetails = JSON.parse(minterConfigRes.extraMinterDetails);
      expect(extraMinterDetails.startPrice).toBe(targetStartPrice.toString());
      expect(extraMinterDetails.startTime).toBe(targetAuctionStart);
      expect(extraMinterDetails.halfLifeSeconds).toBe(600);
      const approxDALength = getApproxDAExpLength(
        targetStartPrice,
        targetBasePrice,
        600
      );
      expect(extraMinterDetails.approximateDAExpEndTime).toBe(
        targetAuctionStart + approxDALength
      );
    });
  });
});
