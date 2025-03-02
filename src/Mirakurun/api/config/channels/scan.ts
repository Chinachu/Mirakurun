/*
   Copyright 2017 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import { Operation } from "express-openapi";
import * as api from "../../../api";
import * as common from "../../../common";
import * as config from "../../../config";
import * as db from "../../../db";
import _ from "../../../_";

/**
 * Global flag to track if scan is in progress
 */
let isScanning = false;

/**
 * Global flag to track if scan cancellation is requested
 */
let isCancellationRequested = false;

/**
 * Global object to track current scan status
 */
interface CurrentScanStatus {
    status: ScanPhase;
    type: common.ChannelType;
    dryRun: boolean;
    progress: number;
    currentChannel: string;
    scanLog: string[];
    newCount: number;
    takeoverCount: number;
    result: config.Channel[];
    startTime: number;
    updateTime: number;
}

let currentScanStatus: CurrentScanStatus | null = null;

/**
 * Options for string comparison when sorting channels
 */
const compareOptions: Intl.CollatorOptions = {
    sensitivity: "base" as const,
    numeric: true
};

/**
 * Channel type order for sorting
 */
const channelOrder: Record<common.ChannelType, number> = {
    GR: 1,
    BS: 2,
    CS: 3,
    SKY: 4
};

/**
 * Scan modes for channel scanning
 */
enum ScanMode {
    Channel = "Channel", // Channel-based scanning (one entry per channel)
    Service = "Service"  // Service-based scanning (one entry per service)
}

/**
 * Overall phase status codes for the scanning process
 */
enum ScanPhase {
    NotStarted = "not_started",           // No scan has been started
    Scanning = "scanning",                // Currently scanning
    Completed = "completed",              // Scan completed successfully
    Cancelled = "cancelled",              // Scan was cancelled by user
    Error = "error"                       // Error occurred
}

/**
 * Process step status codes for the scanning process
 */
enum ScanStep {
    Started = "started",                  // Scan has started
    ScanningChannel = "scanning_channel", // Currently scanning a specific channel
    Takeover = "takeover",                // Taking over existing channel config
    Skipped = "skipped",                  // Channel was skipped
    ServicesFound = "services_found",     // Services found on channel
    ChannelsFound = "channels_found",     // Channels found after scan
    Error = "error"                       // Error occurred during scanning
}

/**
 * Result type status codes for the scanning process
 */
enum ScanResultType {
    Summary = "summary",                  // Scan summary info
    SummaryNew = "summary_new",           // New channels summary
    SummaryTakeover = "summary_takeover", // Takeover channels summary
    RestartRequired = "restart_required", // Restart required to apply changes
    FinalResult = "final_result"          // Final scan results
}

/**
 * Channel name format templates
 */
const CHANNEL_NAME_FORMAT_GR = "{ch}";                // GR channel format
const CHANNEL_NAME_FORMAT_BS = "{ch}";                // BS channel format
const CHANNEL_NAME_FORMAT_BS_SUBCH = "BS{ch00}_{subch}"; // BS subchannel format
const CHANNEL_NAME_FORMAT_CS = "CS{ch}";              // CS channel format

/**
 * Options for a channel scan operation
 */
interface ChannelScanOption {
    type: common.ChannelType;          // Channel type
    startCh?: number;                  // Start channel number
    endCh?: number;                    // End channel number
    startSubCh?: number;               // Start subchannel number (for BS)
    endSubCh?: number;                 // End subchannel number (for BS)
    useSubCh?: boolean;                // Use subchannel style (for BS)
    scanMode?: ScanMode;               // Scan mode
    setDisabledOnAdd?: boolean;        // Set disabled flag on newly added channels
    refresh?: boolean;                 // Refresh existing channel configs
    channelNameFormat?: string;        // Custom channel name format
}

/**
 * Configuration for a scan operation
 */
interface ScanConfig {
    readonly channels: string[];         // List of channel identifiers to scan
    readonly scanMode: ScanMode;         // Scan mode to use
    readonly setDisabledOnAdd: boolean;  // Whether to set disabled on new channels
}

/**
 * Result structure for a scan operation
 */
interface ScanStatusInfo {
    status: ScanPhase;                // Current phase of scan
    type: common.ChannelType;          // Channel type being scanned
    dryRun: boolean;                   // Whether this is a dry run
    progress: number;                  // Progress percentage (0-100)
    currentChannel: string;            // Current channel being scanned
    scanLog: string[];                 // Log of scan operations
    newCount: number;                  // Count of new channels found
    takeoverCount: number;             // Count of existing configs taken over
    result: config.Channel[];          // Resulting channel configurations
}

/**
 * Generate an array of numbers in a range
 *
 * @param start The start number of the range (inclusive)
 * @param end The end number of the range (inclusive)
 * @returns Array of numbers from start to end
 */
function range(start: number, end: number): number[] {
    return Array.from({ length: (end - start + 1) }, (_, i) => i + start);
}

/**
 * Format a channel name using placeholders
 *
 * @param format The format string with placeholders like {ch}, {ch00}, {subch}
 * @param ch The channel number
 * @param subch The optional subchannel number
 * @returns The formatted channel name
 *
 * Supported placeholder formats:
 * - {ch} - Channel number
 * - {ch0}, {ch00}, etc. - Channel number with zero padding
 * - {subch} - Subchannel number
 * - {subch0}, {subch00}, etc. - Subchannel number with zero padding
 */
function formatChannelName(format: string, ch: number, subch?: number): string {
    const values = new Map<string, string>();
    // Find all placeholders in format {name}
    const placeholders = format.match(/({[\\_a-zA-Z0-9]+})/g);

    if (placeholders) {
        for (const placeholder of placeholders) {
            // Handle {ch} or {ch00} style placeholders
            const chDigits = placeholder.match(/{ch([0]*)}/);
            if (chDigits) {
                const digits = chDigits[1] ? chDigits[1].length : 1;
                values.set(placeholder, (ch ?? 0).toString(10).padStart(digits, "0"));
            }

            // Handle {subch} or {subch00} style placeholders
            const subchDigits = placeholder.match(/{subch([0]*)}/);
            if (subchDigits) {
                const digits = subchDigits[1] ? subchDigits[1].length : 1;
                values.set(placeholder, (subch ?? 0).toString(10).padStart(digits, "0"));
            }
        }
    }

    // Replace all placeholders with their values
    let formatted = format;
    for (const [key, value] of values) {
        while (formatted.includes(key)) {
            formatted = formatted.replace(key, value);
        }
    }

    return formatted;
}

/**
 * Generates a scan configuration for a given channel type and options
 *
 * @param option The scan options including channel type, ranges, and formatting
 * @returns A scan configuration with channels to scan and associated settings
 */
export function generateScanConfig(option: ChannelScanOption): ScanConfig | undefined {
    // Remove undefined properties from options
    Object.keys(option).forEach(key => option[key] === undefined && delete option[key]);

    // Handle GR (Ground) channels
    if (option.type === common.ChannelTypes.GR) {
        // Set GR-specific defaults
        const grOptions = {
            startCh: 13,
            endCh: 62,
            scanMode: ScanMode.Channel,
            setDisabledOnAdd: false,
            ...option
        };

        // Generate channel list using range and format
        const channelFormat = grOptions.channelNameFormat || CHANNEL_NAME_FORMAT_GR;
        return {
            channels: range(grOptions.startCh, grOptions.endCh)
                .map(ch => formatChannelName(channelFormat, ch)),
            scanMode: grOptions.scanMode,
            setDisabledOnAdd: grOptions.setDisabledOnAdd
        };
    }

    // Default options for satellite channels (BS/CS)
    const satelliteOptions = {
        scanMode: ScanMode.Service,
        setDisabledOnAdd: true,
        ...option
    };

    // Handle BS (Broadcast Satellite) channels
    if (option.type === common.ChannelTypes.BS) {
        // Handle subchannel style BS scanning (e.g. BS01_0)
        if (satelliteOptions.useSubCh) {
            const bsSubchOptions = {
                startCh: 1,
                endCh: 23,
                startSubCh: 0,
                endSubCh: 3,
                ...satelliteOptions
            };

            // Generate cross product of channels and subchannels
            const channels: string[] = [];
            const channelFormat = bsSubchOptions.channelNameFormat || CHANNEL_NAME_FORMAT_BS_SUBCH;

            for (const ch of range(bsSubchOptions.startCh, bsSubchOptions.endCh)) {
                for (const subCh of range(bsSubchOptions.startSubCh, bsSubchOptions.endSubCh)) {
                    channels.push(formatChannelName(channelFormat, ch, subCh));
                }
            }

            return {
                channels,
                scanMode: bsSubchOptions.scanMode,
                setDisabledOnAdd: bsSubchOptions.setDisabledOnAdd
            };
        }

        // Regular BS channel style (e.g. 101-256)
        const bsOptions = {
            startCh: 101,
            endCh: 256,
            ...satelliteOptions
        };

        const channelFormat = bsOptions.channelNameFormat || CHANNEL_NAME_FORMAT_BS;
        return {
            channels: range(bsOptions.startCh, bsOptions.endCh)
                .map(ch => formatChannelName(channelFormat, ch)),
            scanMode: bsOptions.scanMode,
            setDisabledOnAdd: bsOptions.setDisabledOnAdd
        };
    }

    // Handle CS (Communication Satellite) channels
    if (option.type === common.ChannelTypes.CS) {
        const csOptions = {
            startCh: 2,
            endCh: 24,
            ...satelliteOptions
        };

        const channelFormat = csOptions.channelNameFormat || CHANNEL_NAME_FORMAT_CS;
        return {
            channels: range(csOptions.startCh, csOptions.endCh)
                .map(ch => formatChannelName(channelFormat, ch)),
            scanMode: csOptions.scanMode,
            setDisabledOnAdd: csOptions.setDisabledOnAdd
        };
    }

    return undefined;
}

/**
 * Generates a channel item for a specific service
 *
 * @param type The channel type (GR, BS, CS, SKY)
 * @param channel The channel identifier
 * @param service The service information
 * @param setDisabledOnAdd Whether to set the channel as disabled initially
 * @returns A channel configuration object
 */
export function generateChannelItemForService(
    type: common.ChannelType,
    channel: string,
    service: db.Service,
    setDisabledOnAdd: boolean
): config.Channel {
    // Use service name, or fallback to generated name if empty
    let name = service.name.trim();
    if (name.length === 0) {
        name = `${type}${channel}:${service.serviceId}`;
    }

    return {
        name,
        type,
        channel,
        serviceId: service.serviceId,
        isDisabled: setDisabledOnAdd
    };
}

/**
 * Generates a channel item for a channel with multiple services
 * Finding a common prefix among all service names for the channel name
 *
 * @param type The channel type (GR, BS, CS, SKY)
 * @param channel The channel identifier
 * @param services Array of services on this channel
 * @param setDisabledOnAdd Whether to set the channel as disabled initially
 * @returns A channel configuration object
 */
export function generateChannelItemForChannel(
    type: common.ChannelType,
    channel: string,
    services: db.Service[],
    setDisabledOnAdd: boolean
): config.Channel {
    // Find the common prefix among all service names
    const baseName = services[0].name;
    let matchIndex = baseName.length;

    // Compare each service name with the base name to find the common prefix
    for (let servicesIndex = 1; servicesIndex < services.length; servicesIndex++) {
        const service = services[servicesIndex];
        for (let nameIndex = 0; nameIndex < baseName.length && nameIndex < service.name.length; nameIndex++) {
            // If characters don't match
            if (baseName[nameIndex] !== service.name[nameIndex]) {
                if (nameIndex === 0) {
                    break; // No common prefix at all
                }
                if (nameIndex < matchIndex) {
                    matchIndex = nameIndex; // Update the match length
                }
                break;
            }
            // If this service name is shorter and is a prefix of the base name
            if (nameIndex + 1 >= service.name.length && service.name.length < matchIndex) {
                matchIndex = service.name.length;
                break;
            }
        }
    }

    // Extract and clean up the common prefix
    let name = baseName.slice(0, matchIndex).trim();
    if (name.length === 0) {
        name = `${type}${channel}`; // Fallback name if no common prefix
    }

    return {
        name,
        type,
        channel,
        isDisabled: setDisabledOnAdd
    };
}

/**
 * Generates channel items based on scan mode, either per service or per channel
 *
 * @param scanMode The scan mode (Service or Channel)
 * @param type The channel type (GR, BS, CS, SKY)
 * @param channel The channel identifier
 * @param services Array of services found on this channel
 * @param setDisabledOnAdd Whether to set new channels as disabled
 * @returns Array of channel configuration objects
 */
export function generateChannelItems(
    scanMode: ScanMode,
    type: common.ChannelType,
    channel: string,
    services: db.Service[],
    setDisabledOnAdd: boolean
): config.Channel[] {
    // Service mode: create one channel item per service
    if (scanMode === ScanMode.Service) {
        return services.map(service =>
            generateChannelItemForService(type, channel, service, setDisabledOnAdd)
        );
    }

    // Channel mode: create one channel item for all services
    return [generateChannelItemForChannel(type, channel, services, setDisabledOnAdd)];
}
/**
 * Base interface for scan status updates
 */
interface BaseScanStatusUpdate {
    channel?: string;
    type?: common.ChannelType;
}

/**
 * Interface for phase status updates
 */
interface PhaseScanStatusUpdate extends BaseScanStatusUpdate {
    status: ScanPhase;
    error?: string;
    saved?: boolean;
    dryRun?: boolean;
}

/**
 * Interface for step status updates
 */
interface StepScanStatusUpdate extends BaseScanStatusUpdate {
    status: ScanStep;
    progress?: number;
    enabled?: boolean;
    reason?: string;
    items?: config.Channel[];
    count?: number;
}

/**
 * Interface for result status updates
 */
interface ResultScanStatusUpdate extends BaseScanStatusUpdate {
    status: ScanResultType;
    newCount?: number;
    takeoverCount?: number;
    result?: config.Channel[];
}

/**
 * Union type for all scan status updates
 */
type ScanStatusUpdate = PhaseScanStatusUpdate | StepScanStatusUpdate | ResultScanStatusUpdate;

/**
 * Executes the channel scanning process
 *
 * @param scanConfig Configuration for the scan including channels to scan
 * @param dryRun If true, don't save changes
 * @param type Channel type being scanned (GR, BS, CS, SKY)
 * @param refresh Whether to rescan channels that already exist
 * @param outputWriter Optional function to write output text during scan
 * @returns Promise resolving to the final channel list
 */
async function runChannelScan(
    scanConfig: ScanConfig,
    dryRun: boolean,
    type: common.ChannelType,
    refresh: boolean,
    outputWriter?: (text: string) => void,
    skipCh: number[] = []
): Promise<config.Channel[]> {
    try {
        // Initialize scan data
        const scanLog: string[] = [];
        const oldChannelItems = config.loadChannels();
        // Filter out channels of the type we're scanning (they'll be replaced)
        const result: config.Channel[] = oldChannelItems.filter(channel => channel.type !== type);
        let newCount = 0;
        let takeoverCount = 0;

        // Initialize global scan status
        const now = Date.now();
        currentScanStatus = {
            status: ScanPhase.Scanning,
            type,
            dryRun,
            progress: 0,
            currentChannel: "",
            scanLog,
            newCount,
            takeoverCount,
            result: [],
            startTime: now,
            updateTime: now
        };

        /**
         * Updates scan phase status
         * @param update Phase status update
         * @param textOutput Optional text output for logs
         */
        const updatePhaseStatus = (update: PhaseScanStatusUpdate, textOutput?: string): void => {
            if (!currentScanStatus) {
                return;
            }

            currentScanStatus.status = update.status;
            if (update.channel) {
                currentScanStatus.currentChannel = update.channel;
            }

            appendToLog(textOutput);
        };

        /**
         * Updates scan step status
         * @param update Step status update
         * @param textOutput Optional text output for logs
         */
        const updateStepStatus = (update: StepScanStatusUpdate, textOutput?: string): void => {
            if (!currentScanStatus) {
                return;
            }

            if (update.progress !== undefined) {
                currentScanStatus.progress = update.progress;
            }
            if (update.channel) {
                currentScanStatus.currentChannel = update.channel;
            }
            currentScanStatus.updateTime = Date.now();

            appendToLog(textOutput);
        };

        /**
         * Updates scan result status
         * @param update Result status update
         * @param textOutput Optional text output for logs
         */
        const updateResultStatus = (update: ResultScanStatusUpdate, textOutput?: string): void => {
            if (!currentScanStatus) {
                return;
            }

            if (update.newCount !== undefined) {
                currentScanStatus.newCount = update.newCount;
            }
            if (update.takeoverCount !== undefined) {
                currentScanStatus.takeoverCount = update.takeoverCount;
            }
            if (update.result) {
                currentScanStatus.result = update.result;
            }

            appendToLog(textOutput);
        };

        /**
         * Appends text to scan log and writes output
         * @param textOutput Text to append
         */
        const appendToLog = (textOutput?: string): void => {
            if (textOutput && currentScanStatus) {
                const trimmedText = textOutput.trim();
                currentScanStatus.scanLog.push(trimmedText);
                if (outputWriter) {
                    outputWriter(textOutput);
                }
            }
        };

        // Print dry run notice if applicable
        if (dryRun) {
            appendToLog("-- dry run --\n\n");
        }

        // Print scan start message
        updateStepStatus(
            { status: ScanStep.Started, type },
            `channel scanning... (type: "${type}")\n\n`
        );

        // Process each channel in the scan configuration
        const totalChannels = scanConfig.channels.length;
        for (let i = 0; i < totalChannels; i++) {
            // Check if scanning has been cancelled
            if (isCancellationRequested) {
                updatePhaseStatus(
                    { status: ScanPhase.Cancelled },
                    "Channel scan was cancelled by user request.\n"
                );
                break;
            }
            const channel = scanConfig.channels[i];
            const progressPercent = Math.round((i + 1) / totalChannels * 100);

            // Check if this channel should be skipped based on skipCh parameter
            const channelNumber = parseInt(channel.replace(/[^0-9]/g, ""), 10);
            if (!isNaN(channelNumber) && skipCh.includes(channelNumber)) {
                updateStepStatus(
                    {
                        status: ScanStep.Skipped,
                        channel,
                        reason: "skip_parameter",
                        progress: progressPercent
                    },
                    `channel: "${channel}" (${i + 1}/${totalChannels}) [${progressPercent}%] - skipped by skipCh parameter\n\n`
                );
                continue; // Skip to next channel
            }

            // Update status to show current channel being scanned
            updateStepStatus(
                {
                    status: ScanStep.ScanningChannel,
                    channel,
                    progress: progressPercent
                },
                `channel: "${channel}" (${i + 1}/${totalChannels}) [${progressPercent}%] ...\n`
            );

            // Check for existing enabled channels if we're not refreshing
            if (!refresh) {
                const existingChannels = oldChannelItems.filter(
                    item => item.type === type &&
                           item.channel === channel &&
                           !item.isDisabled
                );

                // If there are existing channels, take them over instead of scanning
                if (existingChannels.length > 0) {
                    const takeoverInfo = {
                        status: ScanStep.Takeover,
                        channel,
                        count: existingChannels.length,
                        items: existingChannels
                    };

                    updateStepStatus(
                        takeoverInfo,
                        `-> ${existingChannels.length} existing config found.\n`
                    );

                    // Add each existing channel to results
                    for (const channelItem of existingChannels) {
                        result.push(channelItem);
                        takeoverCount++;
                        appendToLog(`-> ${JSON.stringify(channelItem)}\n`);
                    }

                    updateStepStatus(
                        {
                            status: ScanStep.Skipped,
                            channel,
                            reason: "existing_config"
                        },
                        `# scan has skipped due to the "refresh = false" option because an existing config was found.\n\n`
                    );

                    continue; // Skip to next channel
                }
            }

            // Scan the channel for services
            let services: db.Service[];
            try {
                // Get services from the tuner
                services = await _.tuner.getServices(<any> {
                    type,
                    channel
                });
            } catch (error) {
                // Handle errors (often no signal)
                const isNoSignalError = /stream has closed before get network/.test(String(error));
                const errorInfo = {
                    status: ScanStep.Error,
                    channel,
                    reason: isNoSignalError ? "no_signal" : String(error),
                    progress: progressPercent
                };

                let errorText = "-> no signal.";
                if (!isNoSignalError) {
                    errorText += ` [${error}]`;
                }
                errorText += "\n\n";

                updateStepStatus(errorInfo, errorText);
                continue; // Skip to next channel
            }

            // Filter services to television types (1 = digital TV, 173 = temporary digital TV)
            services = services.filter(service => service.type === 1 || service.type === 173);

            updateStepStatus(
                {
                    status: ScanStep.ServicesFound,
                    channel,
                    count: services.length
                },
                `-> ${services.length} services found.\n`
            );

            // Skip if no services found
            if (services.length === 0) {
                appendToLog("\n");
                continue;
            }

            // Generate channel items based on scan mode (Service or Channel)
            const scannedChannelItems = generateChannelItems(
                scanConfig.scanMode,
                type,
                channel,
                services,
                scanConfig.setDisabledOnAdd
            );

            // Add newly scanned items to results
            const scannedItems: config.Channel[] = [];
            for (const newChannelItem of scannedChannelItems) {
                result.push(newChannelItem);
                newCount++;
                scannedItems.push(newChannelItem);
                appendToLog(`-> ${JSON.stringify(newChannelItem)}\n`);
            }

            updateStepStatus(
                {
                    status: ScanStep.ChannelsFound,
                    channel,
                    items: scannedItems
                },
                `Found ${scannedItems.length} channels for ${channel}\n\n`
            );
        }

        // Sort results by type and channel number
        result.sort((a, b) => {
            if (a.type === b.type) {
                return a.channel.localeCompare(b.channel, undefined, compareOptions);
            } else {
                return channelOrder[a.type] - channelOrder[b.type];
            }
        });

        // Generate and display summary
        const summaryData = {
            status: ScanResultType.Summary,
            newCount,
            takeoverCount,
            totalTypeCount: newCount + takeoverCount,
            totalCount: result.length,
            type
        };

        updateResultStatus(
            summaryData,
            `-> total ${newCount + takeoverCount}/${result.length} (${type}/Any) channels configured.\n\n`
        );

        updateResultStatus(
            { status: ScanResultType.SummaryNew, newCount },
            `-> new ${newCount} channels found.\n`
        );

        updateResultStatus(
            { status: ScanResultType.SummaryTakeover, takeoverCount },
            `-> existing ${takeoverCount} channels merged.\n`
        );

        // If canceled, do not set to Completed
        if (!isCancellationRequested) {
            // Save results if not a dry run
            if (!dryRun) {
                await config.saveChannels(result);
                updatePhaseStatus(
                    { status: ScanPhase.Completed, saved: true },
                    "channel scan has been completed and saved successfully.\n"
                );
                updateResultStatus(
                    { status: ScanResultType.RestartRequired },
                    "**RESTART REQUIRED** to apply changes.\n"
                );
            } else {
                updatePhaseStatus(
                    { status: ScanPhase.Completed, dryRun: true },
                    "channel scan has been completed.\n\n-- dry run --\n"
                );
            }
        }

        // Send final result
        updateResultStatus(
            {
                status: ScanResultType.FinalResult,
                result
            },
            `Final result: ${result.length} channels\n`
        );

        return result;
    } finally {
        // Always reset scanning and cancellation flags when done
        isScanning = false;
        isCancellationRequested = false;
    }
}

/**
 * Get channel scan status - API handler
 */
export const get: Operation = async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // If no scan has been performed yet
    if (currentScanStatus === null) {
        api.responseJSON(res, {
            status: "not_started",
            isScanning
        });
        return;
    }

    // Return current scan status
    api.responseJSON(res, {
        ...currentScanStatus,
        isScanning
    });
};

get.apiDoc = {
    tags: ["config"],
    summary: "Get Channel Scan Status",
    description: "Returns the current or last completed scan status and results",
    operationId: "getChannelScanStatus",
    produces: [
        "application/json"
    ],
    responses: {
        200: {
            description: "OK",
            schema: {
                $ref: "#/definitions/ChannelScanStatus"
            }
        }
    }
};

/**
 * Initiate a channel scan - API handler
 */
export const put: Operation = async (req, res) => {
    // Check if a scan is already in progress
    if (isScanning === true) {
        api.responseError(res, 409, "Already Scanning");
        return;
    }

    // Set scanning flag
    isScanning = true;

    // Extract query parameters
    const asyncMode = Boolean(req.query.async);
    const dryRun = Boolean(req.query.dryRun);
    const type = req.query.type as common.ChannelType;
    const refresh = Boolean(req.query.refresh);

    // Parse skipCh parameter
    const skipCh: number[] = req.query?.skipCh as any as number[] || [];

    // Parse channel configuration options
    const channelOptions: ChannelScanOption = {
        type,
        startCh: req.query.minCh ? Number(req.query.minCh) : undefined,
        endCh: req.query.maxCh ? Number(req.query.maxCh) : undefined,
        startSubCh: req.query.minSubCh ? Number(req.query.minSubCh) : undefined,
        endSubCh: req.query.maxSubCh ? Number(req.query.maxSubCh) : undefined,
        useSubCh: req.query.useSubCh !== undefined ? Boolean(req.query.useSubCh) : undefined,
        channelNameFormat: req.query.channelNameFormat as string,
        scanMode: req.query.scanMode as ScanMode,
        setDisabledOnAdd: req.query.setDisabledOnAdd !== undefined ?
            Boolean(req.query.setDisabledOnAdd) : undefined
    };

    // Generate scan configuration
    const scanConfig = generateScanConfig(channelOptions);

    // Handle missing scan configuration
    if (!scanConfig) {
        isScanning = false;
        api.responseError(res, 400, "Invalid scan configuration");
        return;
    }

    // Handle asynchronous scan mode
    if (asyncMode) {
        res.status(202);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.json({
            status: "accepted",
            message: "Channel scan started in async mode"
        });
        res.end();

        // Run scan in background
        runChannelScan(scanConfig, dryRun, type, refresh, null, skipCh)
            .catch(error => {
                console.error("Channel scan error:", error);
                if (currentScanStatus) {
                    // ScanPhase.Error is used only when the scan is stopped
                    currentScanStatus.status = ScanPhase.Error;
                    currentScanStatus.scanLog.push(`Error: ${String(error)}`);
                }
                isScanning = false;
            });

        return;
    }

    // Synchronous mode - wait for completion
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200);

    // Set longer timeout for synchronous scan mode
    req.setTimeout(1000 * 60 * 30); // 30 minutes

    try {
        // Stream output directly to response
        const logTextOutput = (textContent: string): void => {
            res.write(textContent);
        };

        // Run scan with output streaming
        await runChannelScan(scanConfig, dryRun, type, refresh, logTextOutput, skipCh);
        res.end();
    } catch (error) {
        console.error("Channel scan error:", error);
        if (currentScanStatus) {
            // ScanPhase.Error is used only when the scan is stopped
            currentScanStatus.status = ScanPhase.Error;
            currentScanStatus.scanLog.push(`Error: ${String(error)}`);
        }
        res.write(`Error during scan: ${error}\n`);
        res.end();
        isScanning = false;
    }
};

/**
 * Stop a channel scan in progress - API handler
 */
export const del: Operation = async (req, res) => {
    // Check if a scan is currently in progress
    if (!isScanning) {
        api.responseError(res, 404, "No scan in progress");
        return;
    }

    // Check if a cancellation is already requested
    if (isCancellationRequested) {
        api.responseError(res, 409, "Already Stopping");
        return;
    }

    // Set cancellation flag to true to request scan to stop
    isCancellationRequested = true;

    // Update the scan status
    if (currentScanStatus) {
        currentScanStatus.status = ScanPhase.Cancelled;
        currentScanStatus.scanLog.push("Scan cancellation requested by user.");
    }

    // Return success response
    res.status(206);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({
        status: "stopping",
        message: "Channel scan stop has been requested"
    });
};

/**
 * API documentation for the DELETE channel scan endpoint
 */
del.apiDoc = {
    tags: ["config"],
    summary: "Stop Channel Scan",
    description: "Stops a currently running channel scan operation",
    operationId: "stopChannelScan",
    produces: [
        "application/json"
    ],
    responses: {
        206: {
            description: "Accepted",
            schema: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["stopping"]
                    },
                    message: {
                        type: "string"
                    }
                }
            }
        },
        404: {
            description: "No scan in progress",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};

/**
 * API documentation for the channel scan endpoint
 */
put.apiDoc = {
    tags: ["config"],
    summary: "Channel Scan",
    description: `Entry rewriting specifications:
- The scan is performed on a range of channels of the specified type and the entries for those channels, if any, are saved in the configuration file.
- If the channel to be scanned is described in the configuration file and is enabled, the scan will not be performed for that channel and the entries described will remain intact. If you do not want to keep the entries, use the \`refresh\` option.
- All entries outside the channel range of the specified type will be deleted.
- All entries of a type other than the specified type will remain.

About BS Subchannel Style:
- Only when scanning BS, you can specify the channel number in the subchannel style (e.g. BS01_0). To specify the channel number, use minSubCh and maxSubCh in addition to minCh and maxCh.
- The subchannel number parameters (minSubCh, maxSubCh) are used only if the type is BS and are ignored otherwise.
- Subchannel style scans scan in the following range:
    From \`BS\${minCh}_\${minSubCh}\` to \`BS\${maxCh}_\${maxSubCh}\`
- In the subchannel style, minCh and maxCh are zero padded to two digits. minSubCh and maxSubCh are not padded.
- BS "non" subchannel style scans and GR scans are basically the same. Note that if you scan the wrong channel range, the GR channel will be registered as BS and the BS channel will be registered as GR. This problem does not occur because CS scan uses a character string with \`CS\` added as a channel number prefix.`,
    operationId: "channelScan",
    produces: [
        "text/plain",
        "application/json"
    ],
    parameters: [
        {
            in: "query",
            name: "dryRun",
            type: "boolean",
            allowEmptyValue: true,
            default: false,
            description: "Dry run mode. If `true`, the scanned result will not be saved to configuration."
        },
        {
            in: "query",
            name: "type",
            type: "string",
            enum: [common.ChannelTypes.GR, common.ChannelTypes.BS, common.ChannelTypes.CS],
            default: common.ChannelTypes.GR,
            description: "Specifies the channel type to scan."
        },
        {
            in: "query",
            name: "minCh",
            type: "integer",
            description: "Specifies the minimum number of channel numbers to scan."
        },
        {
            in: "query",
            name: "maxCh",
            type: "integer",
            description: "Specifies the maximum number of channel numbers to scan."
        },
        {
            in: "query",
            name: "skipCh",
            type: "array",
            items: {
                type: "integer"
            },
            collectionFormat: "csv",
            description: "Comma-separated list of channel numbers to skip during scanning.\n" +
                "Example: `skipCh=13,14,15` will skip channels 13, 14, and 15."
        },
        {
            in: "query",
            name: "minSubCh",
            type: "integer",
            description: "Specifies the minimum number of subchannel numbers to scan. This parameter is only used if the type is `BS` and the useSubCh is `true`."
        },
        {
            in: "query",
            name: "maxSubCh",
            type: "integer",
            description: "Specifies the maximum number of subchannel numbers to scan. This parameter is only used if the type is `BS` and the useSubCh is `true`."
        },
        {
            in: "query",
            name: "useSubCh",
            type: "boolean",
            allowEmptyValue: true,
            default: true,
            description: "Specify true to use the subchannel style for channel numbers. Only used for BS scans. (e.g. BS01_0)"
        },
        {
            in: "query",
            name: "channelNameFormat",
            type: "string",
            allowEmptyValue: true,
            description: "Override format to use for channel name. Supports placeholders like {ch}, {ch00}, {subch}. (e.g. {ch} -> 1, BS{ch00}_{subch} -> BS01_2)"
        },
        {
            in: "query",
            name: "scanMode",
            type: "string",
            enum: [ScanMode.Channel, ScanMode.Service],
            description: "Channel scan mode. Use `Service` mode to create separate entries per service.\n\n" +
                "_Default value (GR)_: Channel\n" +
                "_Default value (BS/CS)_: Service"
        },
        {
            in: "query",
            name: "setDisabledOnAdd",
            type: "boolean",
            allowEmptyValue: true,
            description: "If `true`, newly discovered channels will be added in disabled state.\n\n" +
                "_Default value (GR)_: false\n" +
                "_Default value (BS/CS)_: true"
        },
        {
            in: "query",
            name: "refresh",
            type: "boolean",
            allowEmptyValue: true,
            default: false,
            description: "If `true`, update the existing channel configurations without preserving them.\n" +
                "When false, enabled channels that already exist in the config will be preserved.\n" +
                "Note: Channels of other types will always be preserved regardless of this setting."
        },
        {
            in: "query",
            name: "async",
            type: "boolean",
            allowEmptyValue: true,
            default: false,
            description: "If `true`, the API returns 202 Accepted immediately and performs scan asynchronously.\n" +
                "Use GET /config/channels/scan to monitor progress and retrieve the result."
        }
    ],
    responses: {
        200: {
            description: "OK - Synchronous scan completed",
            schema: {
                type: "string",
                description: "Text output of scan process"
            }
        },
        202: {
            description: "Accepted - Asynchronous scan started",
            schema: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["accepted"]
                    },
                    message: {
                        type: "string"
                    }
                }
            }
        },
        400: {
            description: "Invalid scan configuration",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        409: {
            description: "Already Scanning",
            schema: {
                $ref: "#/definitions/Error"
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
