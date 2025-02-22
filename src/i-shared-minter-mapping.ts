import { BigInt, log, Address } from "@graphprotocol/graph-ts";
import { Project } from "../generated/schema";

import {
  PricePerTokenInWeiUpdated,
  ProjectCurrencyInfoUpdated,
  ProjectMaxInvocationsLimitUpdated,
  // generic events
  ConfigValueSet as ConfigValueSetBool,
  ConfigValueSet1 as ConfigValueSetBigInt,
  ConfigValueSet2 as ConfigValueSetAddress,
  ConfigValueSet3 as ConfigValueSetBytes,
  ConfigKeyRemoved,
  ConfigValueAddedToSet as ConfigValueAddedToSetBigInt,
  ConfigValueAddedToSet1 as ConfigValueAddedToSetAddress,
  ConfigValueAddedToSet2 as ConfigValueAddedToSetBytes,
  ConfigValueRemovedFromSet as ConfigValueRemovedFromSetBigInt,
  ConfigValueRemovedFromSet1 as ConfigValueRemovedFromSetAddress,
  ConfigValueRemovedFromSet2 as ConfigValueRemovedFromSetBytes
} from "../generated/ISharedMinterV0/ISharedMinterV0";

import {
  MinterProjectAndConfig,
  loadOrCreateMinter,
  generateContractSpecificId,
  loadOrCreateProjectMinterConfiguration,
  updateProjectIfMinterConfigIsActive,
  snapshotStateAtSettlementRevenueWithdrawal
} from "./helpers";

import {
  setProjectMinterConfigExtraMinterDetailsValue,
  removeProjectMinterConfigExtraMinterDetailsEntry,
  addProjectMinterConfigExtraMinterDetailsManyValue,
  removeProjectMinterConfigExtraMinterDetailsManyValue
} from "./extra-minter-details-helpers";

///////////////////////////////////////////////////////////////////////////////
// EVENT HANDLERS start here
///////////////////////////////////////////////////////////////////////////////

/**
 * Handles the update of price per token in wei. Attempts to load associated project and
 * its minter configuration, then updates base price in the configuration.
 * @param event The event carrying new price per token in wei
 */
export function handlePricePerTokenInWeiUpdated(
  event: PricePerTokenInWeiUpdated
): void {
  // attempt to load project, if it doesn't exist, log a warning and return
  // @dev we don't support or allow minters to pre-configure projects that do
  // not yet exist
  const project = loadProjectByCoreAddressAndProjectNumber(
    event.params._coreContract,
    event.params._projectId
  );
  if (!project) {
    log.warning("Project {} not found for core contract {}", [
      event.params._projectId.toString(),
      event.params._coreContract.toHexString()
    ]);
    return;
  }

  // load minter
  const minter = loadOrCreateMinter(event.address, event.block.timestamp);

  // load or create project minter configuration
  const projectMinterConfig = loadOrCreateProjectMinterConfiguration(
    project,
    minter
  );

  projectMinterConfig.basePrice = event.params._pricePerTokenInWei;
  projectMinterConfig.priceIsConfigured = true;
  projectMinterConfig.save();

  // induce sync if the project minter configuration is the active one
  updateProjectIfMinterConfigIsActive(
    project,
    projectMinterConfig,
    event.block.timestamp
  );
}

/**
 * Handles the update of a project's currency information. Attempts to load associated
 * project and its minter configuration, then updates currency address and symbol.
 * @param event The event carrying updated currency information
 */
export function handleProjectCurrencyInfoUpdated(
  event: ProjectCurrencyInfoUpdated
): void {
  const minterProjectAndConfig = loadOrCreateMinterProjectAndConfigIfProject(
    event.address, // minter
    event.params._coreContract,
    event.params._projectId,
    event.block.timestamp
  );
  if (!minterProjectAndConfig) {
    // project wasn't found, warning already logged in helper function
    return;
  }

  const projectMinterConfig = minterProjectAndConfig.projectMinterConfiguration;
  projectMinterConfig.currencyAddress = event.params._currencyAddress;
  projectMinterConfig.currencySymbol = event.params._currencySymbol;
  projectMinterConfig.save();

  // induce sync if the project minter configuration is the active one
  updateProjectIfMinterConfigIsActive(
    minterProjectAndConfig.project,
    projectMinterConfig,
    event.block.timestamp
  );
}

export function handleProjectMaxInvocationsLimitUpdated(
  event: ProjectMaxInvocationsLimitUpdated
): void {
  const minterProjectAndConfig = loadOrCreateMinterProjectAndConfigIfProject(
    event.address, // minter
    event.params._coreContract,
    event.params._projectId,
    event.block.timestamp
  );
  if (!minterProjectAndConfig) {
    // project wasn't found, warning already logged in helper function
    return;
  }
  const projectMinterConfig = minterProjectAndConfig.projectMinterConfiguration;
  projectMinterConfig.maxInvocations = event.params._maxInvocations;
  projectMinterConfig.save();

  // induce sync if the project minter configuration is the active one
  updateProjectIfMinterConfigIsActive(
    minterProjectAndConfig.project,
    projectMinterConfig,
    event.block.timestamp
  );
}

///////////////////////////////////////////////////////////////////////////////
// EVENT HANDLERS end here
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
// GENERIC EVENT HANDLERS start here
///////////////////////////////////////////////////////////////////////////////

// CONFIG VALUE SET HANDLERS
export function handleConfigValueSetBool(event: ConfigValueSetBool): void {
  handleSetValueProjectMinterConfig(event);
}

export function handleConfigValueSetBigInt(event: ConfigValueSetBigInt): void {
  handleSetValueProjectMinterConfig(event);
}

export function handleConfigValueSetAddress(
  event: ConfigValueSetAddress
): void {
  handleSetValueProjectMinterConfig(event);
}

export function handleConfigValueSetBytes(event: ConfigValueSetBytes): void {
  handleSetValueProjectMinterConfig(event);
}

function handleSetValueProjectMinterConfig<EventType>(event: EventType): void {
  if (
    !(
      event instanceof ConfigValueSetBool ||
      event instanceof ConfigValueSetBigInt ||
      event instanceof ConfigValueSetAddress ||
      event instanceof ConfigValueSetBytes
    )
  ) {
    return;
  }

  const minterProjectAndConfig = loadOrCreateMinterProjectAndConfigIfProject(
    event.address, // minter
    event.params._coreContract,
    event.params._projectId,
    event.block.timestamp
  );
  if (!minterProjectAndConfig) {
    // project wasn't found, warning already logged in helper function
    return;
  }

  const projectMinterConfig = minterProjectAndConfig.projectMinterConfiguration;
  const key = event.params._key.toString();

  // ---- SYNC EXTRA MINTER DETAILS ----
  if (
    event instanceof ConfigValueSetBigInt &&
    (key.includes("price") || key.includes("Price"))
  ) {
    // always convert BigInt price values to strings to avoid js numeric overflow
    setProjectMinterConfigExtraMinterDetailsValue(
      key,
      event.params._value.toString(), // <--- convert to string
      projectMinterConfig
    );
  } else {
    // default: do not convert to a string
    setProjectMinterConfigExtraMinterDetailsValue(
      key,
      event.params._value,
      projectMinterConfig
    );
  }

  // ---- AFTER-UPDATE HOOKS ----
  // some keys require additional logic to be executed after the update
  if (
    event instanceof ConfigValueSetBool &&
    key == "auctionRevenuesCollected"
  ) {
    // if auction revenues collected is updated, snapshot relevant state
    snapshotStateAtSettlementRevenueWithdrawal(
      projectMinterConfig,
      minterProjectAndConfig.project,
      event.transaction.hash.toHexString()
    );
  }

  // induce sync if the project minter configuration is the active one
  updateProjectIfMinterConfigIsActive(
    minterProjectAndConfig.project,
    projectMinterConfig,
    event.block.timestamp
  );
}

// CONFIG VALUE REMOVED HANDLER
export function handleConfigKeyRemoved(event: ConfigKeyRemoved): void {
  const minterProjectAndConfig = loadOrCreateMinterProjectAndConfigIfProject(
    event.address, // minter
    event.params._coreContract,
    event.params._projectId,
    event.block.timestamp
  );
  if (!minterProjectAndConfig) {
    // project wasn't found, warning already logged in helper function
    return;
  }

  const projectMinterConfig = minterProjectAndConfig.projectMinterConfiguration;
  removeProjectMinterConfigExtraMinterDetailsEntry(
    event.params._key.toString(),
    projectMinterConfig
  );

  // induce sync if the project minter configuration is the active one
  updateProjectIfMinterConfigIsActive(
    minterProjectAndConfig.project,
    projectMinterConfig,
    event.block.timestamp
  );
}

// CONFIG VALUE ADDED TO SET HANDLERS
export function handleConfigValueAddedToSetBigInt(
  event: ConfigValueAddedToSetBigInt
): void {
  handleAddToSetProjectMinterConfig(event);
}

export function handleConfigValueAddedToSetAddress(
  event: ConfigValueAddedToSetAddress
): void {
  handleAddToSetProjectMinterConfig(event);
}

export function handleConfigValueAddedToSetBytes(
  event: ConfigValueAddedToSetBytes
): void {
  handleAddToSetProjectMinterConfig(event);
}

function handleAddToSetProjectMinterConfig<EventType>(event: EventType): void {
  if (
    !(
      event instanceof ConfigValueAddedToSetBigInt ||
      event instanceof ConfigValueAddedToSetAddress ||
      event instanceof ConfigValueAddedToSetBytes
    )
  ) {
    return;
  }

  const minterProjectAndConfig = loadOrCreateMinterProjectAndConfigIfProject(
    event.address, // minter
    event.params._coreContract,
    event.params._projectId,
    event.block.timestamp
  );
  if (!minterProjectAndConfig) {
    // project wasn't found, warning already logged in helper function
    return;
  }

  const projectMinterConfig = minterProjectAndConfig.projectMinterConfiguration;
  addProjectMinterConfigExtraMinterDetailsManyValue(
    projectMinterConfig,
    event.params._key.toString(),
    event.params._value
  );

  // induce sync if the project minter configuration is the active one
  updateProjectIfMinterConfigIsActive(
    minterProjectAndConfig.project,
    projectMinterConfig,
    event.block.timestamp
  );
}

// CONFIG VALUE REMOVED FROM SET HANDLERS
export function handleConfigValueRemovedFromSetBigInt(
  event: ConfigValueRemovedFromSetBigInt
): void {
  handleRemoveFromSetProjectMinterConfig(event);
}

export function handleConfigValueRemovedFromSetAddress(
  event: ConfigValueRemovedFromSetAddress
): void {
  handleRemoveFromSetProjectMinterConfig(event);
}

export function handleConfigValueRemovedFromSetBytes(
  event: ConfigValueRemovedFromSetBytes
): void {
  handleRemoveFromSetProjectMinterConfig(event);
}

function handleRemoveFromSetProjectMinterConfig<EventType>(
  event: EventType
): void {
  if (
    !(
      event instanceof ConfigValueRemovedFromSetBigInt ||
      event instanceof ConfigValueRemovedFromSetAddress ||
      event instanceof ConfigValueRemovedFromSetBytes
    )
  ) {
    return;
  }

  const minterProjectAndConfig = loadOrCreateMinterProjectAndConfigIfProject(
    event.address, // minter
    event.params._coreContract,
    event.params._projectId,
    event.block.timestamp
  );
  if (!minterProjectAndConfig) {
    // project wasn't found, warning already logged in helper function
    return;
  }

  const projectMinterConfig = minterProjectAndConfig.projectMinterConfiguration;
  removeProjectMinterConfigExtraMinterDetailsManyValue(
    projectMinterConfig,
    event.params._key.toString(),
    event.params._value
  );

  // induce sync if the project minter configuration is the active one
  updateProjectIfMinterConfigIsActive(
    minterProjectAndConfig.project,
    projectMinterConfig,
    event.block.timestamp
  );
}

///////////////////////////////////////////////////////////////////////////////
// GENERIC EVENT HANDLERS end here
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
// HELPER FUNCTIONS start here
///////////////////////////////////////////////////////////////////////////////
/**
 * Helper function to attempt to load a project from the store, based on core
 * contract address and project number. If the project does not exist, returns
 * null.
 * @param coreContractAddress core contract address of the project
 * @param projectNumber project number of the project (BigInt)
 * @returns The Project entity from the store if it exists, otherwise null
 */
function loadProjectByCoreAddressAndProjectNumber(
  coreContractAddress: Address,
  projectNumber: BigInt
): Project | null {
  const fullProjectId = generateContractSpecificId(
    coreContractAddress,
    projectNumber
  );
  return Project.load(fullProjectId);
}

export function loadOrCreateMinterProjectAndConfigIfProject(
  minterAddress: Address,
  coreContractAddress: Address,
  projectNumber: BigInt,
  timestamp: BigInt
): MinterProjectAndConfig | null {
  // attempt to load project, if it doesn't exist, log a warning and return
  // @dev we don't support or allow minters to pre-configure projects that do
  // not yet exist
  const project = loadProjectByCoreAddressAndProjectNumber(
    coreContractAddress,
    projectNumber
  );
  if (!project) {
    log.warning("Project {} not found for core contract {}", [
      projectNumber.toString(),
      coreContractAddress.toHexString()
    ]);
    return null;
  }
  const minter = loadOrCreateMinter(minterAddress, timestamp);
  const projectMinterConfiguration = loadOrCreateProjectMinterConfiguration(
    project,
    minter
  );
  return { project, minter, projectMinterConfiguration };
}

///////////////////////////////////////////////////////////////////////////////
// HELPER FUNCTIONS end here
///////////////////////////////////////////////////////////////////////////////
