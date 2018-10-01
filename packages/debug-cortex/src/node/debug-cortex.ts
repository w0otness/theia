/********************************************************************************
 * Copyright (C) 2018 Arm and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/**
 * Configuration passed to adapter from Theia
 * From Theia debug (https://microsoft.github.io/debug-adapter-protocol/specification#Types_InitializeRequestArguments)
 * adapterID:"mbed-debug"
 * clientID:"Theia"
 * columnsStartAt1:true
 * linesStartAt1:true
 * locale:""
 * pathFormat:"path"
 * supportsRunInTerminalRequest:false
 * supportsVariablePaging:false
 * supportsVariableType:false
 */

/**
 * Configuration passed back from adapter
 * From debug adapter (https://microsoft.github.io/debug-adapter-protocol/specification#Types_Capabilities)
 * supportsConditionalBreakpoints:true
 * supportsConfigurationDoneRequest:true
 * supportsEvaluateForHovers:true
 * supportsFunctionBreakpoints:true
 * supportsHitConditionalBreakpoints:true
 * supportsRestartRequest:true
 * supportsSetVariable:true
 */

import { injectable } from 'inversify';
import { DebugConfiguration } from '@theia/debug/lib/common/debug-common';
import { DebugAdapterContribution, DebugAdapterExecutable } from '@theia/debug/lib/node/debug-model';
import { join } from 'path';
import { existsSync } from 'fs';
import * as Ajv from 'ajv';

const packageJson = require('../../package.json');
const debugAdapterDir = packageJson['debugAdapter']['dir'];
const cortexDebugpackageJson = require(`../../${debugAdapterDir}/extension/package.json`);

const OPENOCD_VALID_RTOS: string[] = ['eCos', 'ThreadX', 'FreeRTOS', 'ChibiOS', 'embKernel', 'mqx', 'uCOS-III'];
const JLINK_VALID_RTOS: string[] = ['FreeRTOS', 'embOS'];

@injectable()
export class CortexDebugAdapterContribution implements DebugAdapterContribution {

    // This reflects the debug type used in the adapter and shouldn't change
    public readonly debugType = 'cortex-debug';

    private validators: { [key: string]: Ajv.ValidateFunction };

    constructor() {
        // Load all the defaults from the external cortex's package's json
        // this is a workaround to avoid reimplementing CortexDebugConfigurationProvider
        const debuggerInfo = cortexDebugpackageJson.contributes.debuggers.filter((e: any) => e.type === 'cortex-debug')[0];

        // Debug configurations could be loaded from adapter config
        // this.provideDebugConfigurations = this.debuggerInfo.configurationSnippets.map((s: { body: DebugConfiguration }) => s.body);

        // Create validators which can add default values
        const ajv = new Ajv({
            useDefaults: true,
            validateSchema: false
        });

        const launchSchema = debuggerInfo.configurationAttributes.launch;
        const attachSchema = debuggerInfo.configurationAttributes.attach;
        launchSchema.type = 'object';
        attachSchema.type = 'object';

        this.validators = {
            'launch': ajv.compile(launchSchema),
            'attach': ajv.compile(attachSchema)
        };
    }

    public provideDebugConfigurations = [{
        name: 'J-Link Debug',
        servertype: 'jlink',
        type: this.debugType,
        request: 'launch',
        cwd: '${workspaceFolder}',
        executable: '',
        interface: 'swd',
        device: ''
    },
    {
        name: 'OpenOCD Debug',
        servertype: 'openocd',
        type: this.debugType,
        request: 'launch',
        cwd: '${workspaceFolder}',
        executable: '',
        configFiles: []
    },
    {
        name: 'ST Link Debug',
        servertype: 'stutil',
        type: this.debugType,
        request: 'launch',
        cwd: '${workspaceFolder}',
        executable: '',
        v1: false
    },
    {
        name: 'pyOCD Debug',
        servertype: 'pyocd',
        type: this.debugType,
        request: 'launch',
        cwd: '${workspaceFolder}',
        executable: ''
    },
    {
        name: 'Black Magic Probe Debug',
        servertype: 'bmp',
        type: this.debugType,
        request: 'launch',
        cwd: '${workspaceFolder}',
        executable: '',
        interface: 'swd',
        BMPGDBSerialPort: ''
    }];

    public provideDebugAdapterExecutable(config: DebugConfiguration): DebugAdapterExecutable {
        const program = join(__dirname, `../../${debugAdapterDir}/extension/out/src/gdb.js`);
        return {
            program,
            runtime: 'node'
        };
    }

    public resolveDebugConfiguration(config: DebugConfiguration): DebugConfiguration {

        if (!config.request) {
            config.request = 'launch';
        }

        /**
         *  Set defaults from debug adapter
         */
        const userConfig = config;
        const validator = this.validators[config.request];
        validator(config);
        Object.assign(config, userConfig);

        /**
         * Required settings
         */
        if (!config.executable) {
            throw new Error('Executable is not provided.');
        }

        if (config.cwd) {
            config.executable = join(config.cwd, config.executable);
        }

        /**
         * Default settings from https://github.com/Marus/cortex-debug/blob/master/src/frontend/configprovider.ts
         */
        if (config.debugger_args && !config.debuggerArgs) {
            config.debuggerArgs = config.debugger_args;
        }

        if (!config.swoConfig) {
            config.swoConfig = { enabled: false, decoders: [], cpuFrequency: 0, swoFrequency: 0, source: 'probe' };
        } else {
            if (config.swoConfig.ports && !config.swoConfig.decoders) {
                config.swoConfig.decoders = config.swoConfig.ports;
            }
            if (!config.swoConfig.source) { config.swoConfig.source = 'probe'; }
            if (!config.swoConfig.decoders) { config.swoConfig.decoders = []; }
            config.swoConfig.decoders.forEach((d: any) => {
                if (d.type === 'advanced') {
                    if (d.ports === undefined && d.number !== undefined) {
                        d.ports = [d.number];
                    }
                } else {
                    if (d.port === undefined && d.number !== undefined) {
                        d.port = d.number;
                    }
                }
            });
        }

        if (!config.graphConfig) { config.graphConfig = []; }
        if (!config.preLaunchCommands) { config.preLaunchCommands = []; }
        if (!config.postLaunchCommands) { config.postLaunchCommands = []; }
        if (!config.preAttachCommands) { config.preAttachCommands = []; }
        if (!config.postAttachCommands) { config.postAttachCommands = []; }
        if (!config.preRestartCommands) { config.preRestartCommands = []; }
        if (!config.postRestartCommands) { config.postRestartCommands = []; }

        if (config.request !== 'launch') { config.runToMain = false; }
        if (config.armToolchainPath) { config.toolchainPath = config.armToolchainPath; }
        config.extensionPath = join(__dirname, `../../${debugAdapterDir}/extension/`);

        // Validate server type
        switch (config.servertype) {
            case 'jlink':
                this.verifyJLinkConfiguration(config);
                break;
            case 'openocd':
                this.verifyOpenOCDConfiguration(config);
                break;
            case 'stutil':
                this.verifySTUtilConfiguration(config);
                break;
            case 'pyocd':
                this.verifyPyOCDConfiguration(config);
                break;
            case 'bmp':
                this.verifyBMPConfiguration(config);
                break;
            case 'external':
                this.verifyExternalConfiguration(config);
                break;
            default:
                throw new Error('Invalid servertype parameters. The following values are supported: "jlink", "openocd", "stutil", "pyocd", "bmp"');
                break;
        }

        return config;
    }

    private verifyJLinkConfiguration(config: DebugConfiguration) {
        if (!config.device) {
            // tslint:disable-next-line:max-line-length
            throw new Error('Device Identifier is required for J-Link configurations. Please see https://www.segger.com/downloads/supported-devices.php for supported devices');
        }

        if (config.interface === 'jtag' && config.swoConfig.enabled && config.swoConfig.source === 'probe') {
            throw new Error('SWO Decoding cannot be performed through the J-Link Probe in JTAG mode.');
        }

        if (config.rtos) {
            if (JLINK_VALID_RTOS.indexOf(config.rtos) === -1) {
                if (!existsSync(config.rtos)) {
                    // tslint:disable-next-line:max-line-length
                    throw new Error('The following RTOS values are supported by J-Link: FreeRTOS or embOS. A custom plugin can be used by supplying a complete path to a J-Link GDB Server Plugin.');
                }
            } else {
                config.rtos = `GDBServer/RTOSPlugin_${config.rtos}`;
            }
        }

        if (!config.interface) { config.interface = 'swd'; }
        if (!config.interface && config.jlinkInterface) { config.interface = config.jlinkInterface; }
        if (config.jlinkpath && !config.serverpath) { config.serverpath = config.jlinkpath; }
    }

    private verifyOpenOCDConfiguration(config: DebugConfiguration) {
        if (!config.configFiles || config.configFiles.length === 0) {
            throw new Error('At least one OpenOCD Configuration File must be specified.');
        }

        if (config.rtos && OPENOCD_VALID_RTOS.indexOf(config.rtos) === -1) {
            throw new Error(`The following RTOS values are supported by OpenOCD: ${OPENOCD_VALID_RTOS.join(' ')}`);
        }

        if (config.openOCDPath && !config.serverpath) { config.serverpath = config.openOCDPath; }
        if (!config.searchDir || config.searchDir.length === 0) { config.searchDir = []; }
    }

    private verifySTUtilConfiguration(config: DebugConfiguration) {
        if (config.rtos) {
            throw new Error('The st-util GDB Server does not have support for the rtos option.');
        }

        if (config.stutilpath && !config.serverpath) { config.serverpath = config.stutilpath; }

        if (config.swoConfig.enabled && config.swoConfig.source === 'probe') {
            config.swoConfig = { enabled: false, ports: [], cpuFrequency: 0, swoFrequency: 0 };
            config.graphConfig = [];
        }
    }

    private verifyPyOCDConfiguration(config: DebugConfiguration) {
        if (config.rtos) {
            throw new Error('The PyOCD GDB Server does not have support for the rtos option.');
        }

        if (config.board && !config.boardId) { config.boardId = config.board; }
        if (config.target && !config.targetId) { config.targetId = config.target; }
        if (config.pyocdPath && !config.serverpath) { config.serverpath = config.pyocdPath; }

        if (config.swoConfig.enabled && config.swoConfig.source === 'probe') {
            config.swoConfig = { enabled: false, ports: [], cpuFrequency: 0, swoFrequency: 0 };
            config.graphConfig = [];
        }
    }

    private verifyBMPConfiguration(config: DebugConfiguration) {
        if (!config.BMPGDBSerialPort) {
            throw new Error('A Serial Port for the Black Magic Probe GDB server is required.');
        }

        if (config.rtos) {
            throw new Error('The Black Magic Probe GDB Server does not have support for the rtos option.');
        }

        if (!config.interface) { config.interface = 'swd'; }
        if (!config.targetId) { config.targetId = 1; }

        if (config.swoConfig.enabled && config.swoConfig.source === 'probe') {
            config.swoConfig = { enabled: false, ports: [], cpuFrequency: 0, swoFrequency: 0 };
            config.graphConfig = [];
        }
    }

    private verifyExternalConfiguration(config: DebugConfiguration) {
        if (config.swoConfig.enabled) {
            config.swoConfig = { enabled: false, ports: [], cpuFrequency: 0, swoFrequency: 0 };
            config.graphConfig = [];
        }
    }
}
