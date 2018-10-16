/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
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

// tslint:disable:no-any

import * as React from 'react';
import { WebSocketConnectionProvider, LabelProvider } from '@theia/core/lib/browser';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Emitter, Event, DisposableCollection, Disposable, MessageClient, MessageType } from '@theia/core/lib/common';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { EditorManager } from '@theia/editor/lib/browser';
import { CompositeTreeElement } from '@theia/core/lib/browser/source-tree';
import { DebugConfiguration } from '../common/debug-configuration';
import { DebugSessionConnection, DebugRequestTypes, DebugEventTypes } from './debug-session-connection';
import { DebugThread, StoppedDetails } from './model/debug-thread';
import { DebugScope } from './console/debug-console-items';
import { DebugStackFrame } from './model/debug-stack-frame';
import { DebugSource } from './model/debug-source';
import { DebugBreakpoint } from './model/debug-breakpoint';
import debounce = require('p-debounce');
import URI from '@theia/core/lib/common/uri';
import { BreakpointManager } from './breakpoint/breakpoint-manager';

export enum DebugState {
    Inactive,
    Initializing,
    Running,
    Stopped
}

// FIXME: make injectable to allow easily inject services
export class DebugSession implements CompositeTreeElement {

    protected readonly connection: DebugSessionConnection;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
    protected fireDidChange(): void {
        this.onDidChangeEmitter.fire(undefined);
    }

    protected readonly onDidChangeBreakpointsEmitter = new Emitter<URI>();
    readonly onDidChangeBreakpoints: Event<URI> = this.onDidChangeBreakpointsEmitter.event;
    protected fireDidChangeBreakpoints(uri: URI): void {
        this.onDidChangeBreakpointsEmitter.fire(uri);
    }

    protected readonly toDispose = new DisposableCollection();

    constructor(
        readonly id: string,
        readonly configuration: DebugConfiguration,
        connectionProvider: WebSocketConnectionProvider,
        protected readonly terminalServer: TerminalService,
        protected readonly editorManager: EditorManager,
        protected readonly breakpoints: BreakpointManager,
        protected readonly labelProvider: LabelProvider,
        protected readonly messages: MessageClient
    ) {
        this.connection = new DebugSessionConnection(id, connectionProvider);
        this.connection.onRequest('runInTerminal', (request: DebugProtocol.RunInTerminalRequest) => this.runInTerminal(request));
        this.toDispose.pushAll([
            this.onDidChangeEmitter,
            this.onDidChangeBreakpointsEmitter,
            Disposable.create(() => {
                this.clearBreakpoints();
                this.doUpdateThreads([]);
            }),
            this.connection,
            this.on('initialized', () => this.configure()),
            this.on('continued', ({ body: { allThreadsContinued, threadId } }) => {
                if (allThreadsContinued !== false) {
                    this.clearThreads();
                } else {
                    this.clearThread(threadId);
                }
            }),
            this.on('stopped', async ({ body }) => {
                await this.updateThreads(body);
                await this.updateFrames();
            }),
            this.on('thread', ({ body: { reason, threadId } }) => {
                if (reason === 'started') {
                    this.scheduleUpdateThreads();
                } else if (reason === 'exited') {
                    this.clearThread(threadId);
                }
            }),
            this.on('capabilities', event => this.updateCapabilities(event.body.capabilities)),
            this.breakpoints.onDidChangeMarkers(uri => this.updateBreakpoints({ uri, sourceModified: true }))
        ]);
    }

    dispose(): void {
        this.toDispose.dispose();
    }

    protected _capabilities: DebugProtocol.Capabilities = {};
    get capabilities(): DebugProtocol.Capabilities {
        return this._capabilities;
    }

    protected readonly sources = new Map<string, DebugSource>();
    getSource(raw: DebugProtocol.Source): DebugSource {
        const uri = DebugSource.toUri(raw).toString();
        const source = this.sources.get(uri) || new DebugSource(this, this.editorManager, this.labelProvider);
        source.update({ raw });
        this.sources.set(uri, source);
        return source;
    }
    getSourceForUri(uri: URI): DebugSource | undefined {
        return this.sources.get(uri.toString());
    }
    toSource(uri: URI): DebugSource {
        const source = this.getSourceForUri(uri);
        if (source) {
            return source;
        }
        return this.getSource(DebugSource.toSource(uri));
    }

    protected _threads = new Map<number, DebugThread>();
    get threads(): IterableIterator<DebugThread> {
        return this._threads.values();
    }
    get threadCount(): number {
        return this._threads.size;
    }
    *getThreads(filter: (thread: DebugThread) => boolean): IterableIterator<DebugThread> {
        for (const thread of this.threads) {
            if (filter(thread)) {
                yield thread;
            }
        }
    }
    get runningThreads(): IterableIterator<DebugThread> {
        return this.getThreads(thread => !thread.stopped);
    }
    get stoppedThreads(): IterableIterator<DebugThread> {
        return this.getThreads(thread => thread.stopped);
    }

    async pauseAll(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const thread of this.runningThreads) {
            promises.push((async () => {
                try {
                    await thread.pause();
                } catch (e) {
                    console.error(e);
                }
            })());
        }
        await Promise.all(promises);
    }

    async continueAll(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const thread of this.stoppedThreads) {
            promises.push((async () => {
                try {
                    await thread.continue();
                } catch (e) {
                    console.error(e);
                }
            })());
        }
        await Promise.all(promises);
    }

    get currentFrame(): DebugStackFrame | undefined {
        return this.currentThread && this.currentThread.currentFrame;
    }

    protected _currentThread: DebugThread | undefined;
    protected readonly toDisposeOnCurrentThread = new DisposableCollection();
    get currentThread(): DebugThread | undefined {
        return this._currentThread;
    }
    set currentThread(thread: DebugThread | undefined) {
        this.toDisposeOnCurrentThread.dispose();
        this._currentThread = thread;
        this.fireDidChange();
        if (thread) {
            this.toDisposeOnCurrentThread.push(thread.onDidChanged(() => this.fireDidChange()));
        }
    }

    get state(): DebugState {
        if (this.connection.disposed) {
            return DebugState.Inactive;
        }
        if (!this.initialized) {
            return DebugState.Initializing;
        }
        const thread = this.currentThread;
        if (thread) {
            return thread.stopped ? DebugState.Stopped : DebugState.Running;
        }
        return !!this.stoppedThreads.next().value ? DebugState.Stopped : DebugState.Running;
    }

    async getScopes(): Promise<DebugScope[]> {
        const { currentFrame } = this;
        return currentFrame ? currentFrame.getScopes() : [];
    }

    async start(): Promise<void> {
        await this.initialize();
        await this.launchOrAttach();
    }
    protected async initialize(): Promise<void> {
        const response = await this.connection.sendRequest('initialize', {
            clientID: 'Theia',
            clientName: 'Theia IDE',
            adapterID: this.configuration.type,
            locale: 'en-US',
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: 'path',
            supportsVariableType: false,
            supportsVariablePaging: false,
            supportsRunInTerminalRequest: true
        });
        this._capabilities = response.body || {};
    }
    protected async launchOrAttach(): Promise<void> {
        try {
            if (this.configuration.request === 'attach') {
                await this.sendRequest('attach', this.configuration);
            } else {
                await this.sendRequest('launch', this.configuration);
            }
        } catch (reason) {
            this.connection['fire']('exited', { reason });
            await this.messages.showMessage({
                type: MessageType.Error,
                text: reason.message || 'Debug session initialization failed. See console for details.',
                options: {
                    timeout: 10000
                }
            });
            throw reason;
        }
    }
    protected initialized = false;
    protected async configure(): Promise<void> {
        await this.updateBreakpoints({ sourceModified: false });
        if (this.capabilities.supportsConfigurationDoneRequest) {
            await this.sendRequest('configurationDone', {});
        }
        this.initialized = true;
        await this.updateThreads(undefined);
    }

    async disconnect(args: DebugProtocol.DisconnectArguments = {}): Promise<void> {
        await this.sendRequest('disconnect', args);
    }

    async completions(text: string, column: number, line: number): Promise<DebugProtocol.CompletionItem[]> {
        const frameId = this.currentFrame && this.currentFrame.raw.id;
        const response = await this.sendRequest('completions', { frameId, text, column, line });
        return response.body.targets;
    }

    async evaluate(expression: string, context?: string): Promise<DebugProtocol.EvaluateResponse['body']> {
        const frameId = this.currentFrame && this.currentFrame.raw.id;
        const response = await this.sendRequest('evaluate', { expression, frameId, context });
        return response.body;
    }

    sendRequest<K extends keyof DebugRequestTypes>(command: K, args: DebugRequestTypes[K][0]): Promise<DebugRequestTypes[K][1]> {
        return this.connection.sendRequest(command, args);
    }

    on<K extends keyof DebugEventTypes>(kind: K, listener: (e: DebugEventTypes[K]) => any): Disposable {
        return this.connection.on(kind, listener);
    }
    onCustom<E extends DebugProtocol.Event>(kind: string, listener: (e: E) => any): Disposable {
        return this.connection.onCustom(kind, listener);
    }

    protected async runInTerminal({ arguments: { title, cwd, args, env } }: DebugProtocol.RunInTerminalRequest): Promise<DebugProtocol.RunInTerminalResponse['body']> {
        const terminal = await this.terminalServer.newTerminal({ title, cwd, shellPath: args[0], shellArgs: args.slice(1), env });
        this.terminalServer.activateTerminal(terminal);
        const processId = await terminal.start();
        return { processId };
    }

    protected clearThreads(): void {
        for (const thread of this.threads) {
            thread.clear();
        }
        this.updateCurrentThread();
    }
    protected clearThread(threadId: number): void {
        const thread = this._threads.get(threadId);
        if (thread) {
            thread.clear();
        }
        this.updateCurrentThread();
    }

    protected readonly scheduleUpdateThreads = debounce(() => this.updateThreads(undefined), 100);
    protected pendingThreads = Promise.resolve();
    updateThreads(stoppedDetails: StoppedDetails | undefined): Promise<void> {
        return this.pendingThreads = this.pendingThreads.then(async () => {
            try {
                const response = await this.sendRequest('threads', {});
                this.doUpdateThreads(response.body.threads, stoppedDetails);
            } catch (e) {
                console.error(e);
            }
        });
    }
    protected doUpdateThreads(threads: DebugProtocol.Thread[], stoppedDetails?: StoppedDetails): void {
        const existing = this._threads;
        this._threads = new Map();
        for (const raw of threads) {
            const id = raw.id;
            const thread = existing.get(id) || new DebugThread(this);
            this._threads.set(id, thread);
            thread.update({
                raw,
                stoppedDetails: stoppedDetails && stoppedDetails.threadId === id ? stoppedDetails : undefined
            });
        }
        this.updateCurrentThread(stoppedDetails);
    }

    protected updateCurrentThread(stoppedDetails?: StoppedDetails): void {
        const { currentThread } = this;
        let threadId = currentThread && currentThread.raw.id;
        if (stoppedDetails && !stoppedDetails.preserveFocusHint && !!stoppedDetails.threadId) {
            threadId = stoppedDetails.threadId;
        }
        this.currentThread = typeof threadId === 'number' && this._threads.get(threadId)
            || this._threads.values().next().value;
    }

    protected async updateFrames(): Promise<void> {
        const thread = this._currentThread;
        if (!thread || thread.frameCount) {
            return;
        }
        if (this.capabilities.supportsDelayedStackTraceLoading) {
            await thread.fetchFrames(1);
            await thread.fetchFrames(19);
        } else {
            await thread.fetchFrames();
        }
    }

    protected updateCapabilities(capabilities: DebugProtocol.Capabilities): void {
        Object.assign(this._capabilities, capabilities);
    }

    protected readonly _breakpoints = new Map<string, DebugBreakpoint[]>();
    get breakpointUris(): IterableIterator<string> {
        return this._breakpoints.keys();
    }
    getBreakpoints(uri?: URI): DebugBreakpoint[] {
        if (uri) {
            return this._breakpoints.get(uri.toString()) || [];
        }
        const result = [];
        for (const breakpoints of this._breakpoints.values()) {
            result.push(...breakpoints);
        }
        return result;
    }
    protected clearBreakpoints(): void {
        const uris = [...this._breakpoints.keys()];
        this._breakpoints.clear();
        for (const uri of uris) {
            this.fireDidChangeBreakpoints(new URI(uri));
        }
    }
    protected async updateBreakpoints(options: {
        uri?: URI,
        sourceModified: boolean
    }): Promise<void> {
        const { uri, sourceModified } = options;
        for (const affectedUri of this.getAffectedUris(uri)) {
            const source = this.toSource(affectedUri);
            const all = this.breakpoints.findMarkers({ uri: affectedUri }).map(({ data }) =>
                new DebugBreakpoint(data, this.labelProvider, this.breakpoints, this.editorManager, this)
            );
            const enabled = all.filter(b => b.enabled);
            const response = await this.sendRequest('setBreakpoints', {
                source: source.raw,
                sourceModified,
                breakpoints: enabled.map(({ origin }) => origin.raw)
            });
            response.body.breakpoints.map((raw, index) => enabled[index].update({ raw }));
            const distinct = this.dedupBreakpoints(all);
            this._breakpoints.set(affectedUri.toString(), distinct);
            this.fireDidChangeBreakpoints(affectedUri);
        }
    }
    protected dedupBreakpoints(all: DebugBreakpoint[]): DebugBreakpoint[] {
        const lines = new Map<number, DebugBreakpoint>();
        for (const breakpoint of all) {
            let primary = lines.get(breakpoint.line) || breakpoint;
            if (primary !== breakpoint) {
                let secondary = breakpoint;
                if (secondary.raw && secondary.raw.line === secondary.origin.raw.line) {
                    [primary, secondary] = [breakpoint, primary];
                }
                primary.origins.push(...secondary.origins);
            }
            lines.set(primary.line, primary);
        }
        return [...lines.values()];
    }
    protected *getAffectedUris(uri?: URI): IterableIterator<URI> {
        if (uri) {
            yield uri;
        } else {
            for (const uriString of this.breakpoints.getUris()) {
                yield new URI(uriString);
            }
        }
    }

    get label(): string {
        if (this.configuration.__configurationId) {
            return this.configuration.name + ' (' + (this.configuration.__configurationId + 1) + ')';
        }
        return this.configuration.name;
    }

    get visible(): boolean {
        return this.state > DebugState.Inactive;
    }

    render(): React.ReactNode {
        return <div className='theia-debug-session' title='Session'>
            <span className='label'>{this.label}</span>
            <span className='status'>{this.state === DebugState.Stopped ? 'Paused' : 'Running'}</span>
        </div>;
    }

    getElements(): IterableIterator<DebugThread> {
        return this.threads;
    }

}
