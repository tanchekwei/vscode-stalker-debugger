import { Disposable, DebugAdapter, DebugProtocolMessage, Event, EventEmitter, TaskExecution, DebugSession, tasks, debug, ShellExecution, TaskScope, Task, env, Uri, TaskProcessEndEvent, workspace, WorkspaceFolder } from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';
import { StalkerDebugConfiguration } from './StalkerDebugConfiguration';
import findProcesses from 'find-process';
import { EnvironmentUtil } from './EnvironmentUtil';

export type PreBuildTask = { name: string, commandLine: string, cwd?: string, isBackground?: boolean, waitFor?: boolean, failOnNonZeroExitCode?: boolean, problemMatcher?: any };
export type PreBuildTaskExecution = { definition: PreBuildTask, task: TaskExecution | undefined, hasEnded?: boolean, exitCode?: number | undefined; };

export class StalkerDebugAdapter implements Disposable, DebugAdapter {
    private readonly sendMessage = new EventEmitter<DebugProtocolMessage>();
    onDidSendMessage: Event<DebugProtocolMessage> = this.sendMessage.event;

    private static readonly DefaultIntervalMs = 1000;

    private readonly debugConfiguration: StalkerDebugConfiguration;
    private readonly disposables: { dispose(): any }[] = [];
    private readonly processFileName: string;
    private readonly projectFileName: string;

    private attachedIncrement = 0;
    private checkProcessesTimeout: NodeJS.Timeout | undefined;
    private childPid = 0;
    private debuggerIsStopping = false;
    private dotNetWatchPid = 0;
    private dotNetWatchTask: TaskExecution | undefined;
    private preBuildTasks: { [name: string]: PreBuildTaskExecution } = {};
    private responseSeq = 0;
    private workspaceFolder: WorkspaceFolder | undefined;

    constructor(private readonly debugSession: DebugSession) {
        this.debugConfiguration = debugSession.configuration as StalkerDebugConfiguration;
        this.workspaceFolder = debugSession.workspaceFolder;

        const projectFileName = this.debugConfiguration.project.split(EnvironmentUtil.pathDelimiter).pop();
        if (!projectFileName) throw new Error('project is not valid');
        this.projectFileName = projectFileName;

        const processFileName = this.debugConfiguration.process.split(EnvironmentUtil.pathDelimiter).pop();
        if (!processFileName) throw new Error('process is not valid');
        this.processFileName = processFileName;

        this.disposables.push(debug.onDidStartDebugSession(e => this.handleOnDidStartDebugSession(e)));
        this.disposables.push(debug.onDidTerminateDebugSession(e => this.handleOnDidTerminateDebugSession(e)));
        this.disposables.push(debug.onDidChangeActiveDebugSession(e => this.handleOnDidChangeActiveDebugSession(e)));
        this.disposables.push(tasks.onDidEndTaskProcess(e => this.handleOnDidEndTaskProcess(e)));
    }

    private get isChildProcessRunning(): boolean { return this.childPid !== 0; }

    private get isDotNetWatchRunning(): boolean { return this.dotNetWatchPid !== 0; }

    [Symbol.dispose](): void {
        this.dispose();
    }

    dispose(): any {
        this.stopWatching(false);
        this.disposables.forEach(d => d.dispose());
    }

    async handleMessage(message: DebugProtocol.ProtocolMessage): Promise<void> {
        if (message.type === 'request') {
            const request = message as DebugProtocol.Request;

            if (request.command === 'initialize') {
            }
            else if (request.command === 'launch') {
                await this.startDebugging();
            }
            else if (request.command === 'disconnect') {
                this.stopWatching(false);
            }
            else return; // ! only above commands continue

            this.sendMessage.fire(this.createDebugResponse(request));
        }
    }

    private createDebugResponse(request: DebugProtocol.Request): DebugProtocol.Response {
        return {
            type: 'response',
            request_seq: request.seq,
            seq: this.responseSeq++,
            command: request.command,
            success: true,
            body: {}
        };
    }

    private async getLaunchUrls(): Promise<string[]> {
        const launchProfile = await this.getLaunchSettingsProfile(this.debugConfiguration.cwd.replace(this.workspaceFolder!.uri.fsPath + EnvironmentUtil.pathDelimiter, ""), this.debugConfiguration.launchSettingsProfile || this.debugConfiguration.processOptions.launchSettingsProfile);

        return (launchProfile ? launchProfile.applicationUrl?.split(";") : undefined)
            ?? (this.debugConfiguration.url ? [this.debugConfiguration.url] : []);
    }

    private async getLaunchSettingsProfile(projectDirectory: string, launchSettingsProfile: string | undefined, profileType = "Project"): Promise<{ [key: string]: any } | undefined> {
        if (!launchSettingsProfile) return undefined;

        const launchSettingsFiles = await workspace.findFiles(`${projectDirectory}/**/Properties/launchSettings.json`);
        if (launchSettingsFiles.length !== 1) return undefined;

        let launchSettings: { [key: string]: any } = {};
        try {
            const fileData = await workspace.fs.readFile(launchSettingsFiles[0]);
            const fileContents = Buffer.from(fileData).toString("utf8");
            launchSettings = JSON.parse(fileContents);
            if (launchSettings?.profiles === undefined) return undefined;
        }
        catch (e) {
            throw new Error(`Failed to read launchSettings.json: ${e}`);
        }

        const foundProfileName = Object.keys(launchSettings.profiles).find(p => p === launchSettingsProfile && launchSettings.profiles[p].commandName === profileType);
        return foundProfileName ? launchSettings.profiles[foundProfileName] as { [key: string]: any } : undefined;
    }

    private handleOnDidChangeActiveDebugSession(e: DebugSession | undefined): void {
        if (e?.id === this.debugSession.id || e?.parentSession?.id === this.debugSession.id) {
            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🪲 Debug session became active: ${e?.name} (${e?.type})\n` } });
        }
    }

    private handleOnDidEndTaskProcess(endEvent: TaskProcessEndEvent): void {
        if (endEvent.execution === this.dotNetWatchTask) {
            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: '⌚️ .NET Watch task stopped.\n' } });
            this.stopWatching(true); // full stop
        }
        else {
            const preBuildTask = Object.values(this.preBuildTasks).find(t => t.task === endEvent.execution);
            if (preBuildTask) {
                preBuildTask.hasEnded = true;
                preBuildTask.exitCode = endEvent.exitCode;
                preBuildTask.task = undefined;

                this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🔨 Pre-build task stopped: ${preBuildTask.definition.name} (${preBuildTask.exitCode})\n` } });

                if (preBuildTask.definition.failOnNonZeroExitCode && preBuildTask.exitCode !== 0) {
                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🚫 Pre-build task failed: ${preBuildTask.definition.name} (${preBuildTask.exitCode}). Stopping debugger.\n` } });
                    this.stopWatching(true); // full stop
                }
            }
        }
    }

    private handleOnDidStartDebugSession(e: DebugSession): void {
        if (e.id === this.debugSession.id || e.parentSession?.id === this.debugSession.id) {
            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🪲 Debug session started: ${e.name} (${e.type})\n` } });
        }
    }

    private handleOnDidTerminateDebugSession(e: DebugSession): void {
        if (e.id === this.debugSession.id || e.parentSession?.id === this.debugSession.id) {
            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🪲 Debug session terminated: ${e.name} (${e.type})\n` } });
        }
    }

    private restartCheckProcessesTimeout(timeoutMs: number): void {
        this.stopCheckProcessesTimeout();
        this.startCheckProcessesTimeout(timeoutMs);
    }

    private startCheckProcessesTimeout(timeoutMs: number): void {
        if (!this.dotNetWatchTask) throw new Error('dotnet watch is not running'); // ! this should never happen

        this.checkProcessesTimeout = setTimeout(async () => {
            const dotNetWatchProcessNameRegExp = new RegExp(`dotnet.* watch run .*--project "?${this.debugConfiguration.project.replaceAll("\\", "\\\\")}"?`, "i");
            const dotNetWatchProcesses = await findProcesses("name", dotNetWatchProcessNameRegExp);
            const dotNetWatchProcess = dotNetWatchProcesses.find(x => x.name.toLowerCase().startsWith("dotnet"));

            // if (dotNetWatchProcess) console.log(`dotnet watch command: ${dotNetWatchProcess.cmd}`);
            // else console.log("dotnet watch process not found");

            // dotnet watch...

            if (!dotNetWatchProcess) {
                if (this.isDotNetWatchRunning) {
                    this.dotNetWatchPid = 0;
                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: '‼️ .NET Watch is not running. Stopping debugger.\n' } });

                    this.stopWatching(true); // full stop
                    return;
                }

                this.restartCheckProcessesTimeout(timeoutMs); // keep same interval
                return;
            }
            else if (this.dotNetWatchPid !== dotNetWatchProcess.pid) {
                this.dotNetWatchPid = dotNetWatchProcess.pid;
                this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `⌚️ .NET Watch is now running (${this.dotNetWatchPid}).\n` } });
            }

            // child process (i.e. the project being watched)...

            const projectProcesses = await findProcesses("name", EnvironmentUtil.processFileName(this.processFileName));
            const projectProcess = EnvironmentUtil.getProjectProcess(projectProcesses, this.processFileName);

            // if (projectProcess) console.log(`project process command: ${projectProcess.cmd}`);
            // else console.log("project process not found");

            if (!projectProcess) {
                if (this.isChildProcessRunning) {
                    this.childPid = 0;
                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: '🔥 Child process is no longer running. A hot reload build should be in process.\n' } });

                    this.restartCheckProcessesTimeout(this.debugConfiguration.attachOptions.interval ?? (StalkerDebugAdapter.DefaultIntervalMs / 2)); // (most likely) speeds up the interval
                    return;
                }

                this.restartCheckProcessesTimeout(timeoutMs); // keep same interval
                return;
            }
            else if (this.childPid !== projectProcess.pid) {
                if (this.isChildProcessRunning) {
                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🔄 Child process has been restarted (${projectProcess.pid}).\n` } });
                }
                else {
                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `✅ Child process is now running (${projectProcess.pid}).\n` } });
                }

                this.childPid = projectProcess.pid;

                if (await debug.startDebugging(this.debugSession.workspaceFolder, {
                    name: '.NET Stalker Attach',
                    type: 'coreclr',
                    request: 'attach',
                    processId: this.childPid,
                    logging: this.debugConfiguration.logging,
                    console: this.debugConfiguration.console,
                    ...this.debugConfiguration.attachOptions.taskProperties
                }, this.debugSession)) {
                    this.attachedIncrement++;
                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🔗 Attached to child process (${this.attachedIncrement}).\n` } });

                    const launchUrls = await this.getLaunchUrls();

                    if (this.debugConfiguration.attachOptions.action && this.debugConfiguration.attachOptions.action !== "nothing" && launchUrls.length > 0 && this.debugConfiguration.attachOptions.action === "openExternally") {
                        let url = launchUrls[0].replace("0.0.0.0", "localhost");
                        let urlPath = this.debugConfiguration.attachOptions.urlPath?.trim().replace(/^\/+/, '');
                        if (urlPath) url += `/${urlPath}`;
                        this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🕸️ Opening URL externally (${url}).\n` } });
                        await env.openExternal(Uri.parse(url));
                    }

                    if (this.attachedIncrement === 1 && this.debugConfiguration.attachOptions.action && this.debugConfiguration.attachOptions.action !== "nothing" && launchUrls.length > 0) {
                        let url = launchUrls[0].replace("0.0.0.0", "localhost");
                        let urlPath = this.debugConfiguration.attachOptions.urlPath?.trim().replace(/^\/+/, '');
                        if (urlPath) url += `/${urlPath}`;

                        else if (this.debugConfiguration.attachOptions.action === "debugWithChrome") {
                            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🔍 Debugging with Google Chrome (${url}).\n` } });

                            try {
                                const didStartDebug = await debug.startDebugging(this.debugSession.workspaceFolder, {
                                    name: '.NET Stalker: Chrome',
                                    type: 'chrome',
                                    request: 'launch',
                                    url: url,
                                    webRoot: this.debugConfiguration.webRoot,
                                    ...this.debugConfiguration.attachOptions.browserTaskProperties
                                }, this.debugSession);


                                if (!didStartDebug) {
                                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🚫 Failed to debug with Google Chrome.\n` } });
                                }
                            }
                            catch (e) {
                                this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🚫 Failed to debug with Google Chrome: ${e}\n` } });
                            }
                        }
                        else if (this.debugConfiguration.attachOptions.action === "debugWithFirefox") {
                            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🔍 Debugging with Mozilla Firefox (${url}).\n` } });

                            try {
                                const didStartDebug = await debug.startDebugging(this.debugSession.workspaceFolder, {
                                    name: '.NET Stalker: Firefox',
                                    type: 'firefox',
                                    request: 'launch',
                                    url: url,
                                    webRoot: this.debugConfiguration.webRoot,
                                    reloadOnChange: {
                                        watch: [`${this.debugConfiguration.webRoot}/**/*`]
                                    },
                                    ...this.debugConfiguration.attachOptions.browserTaskProperties
                                }, this.debugSession);

                                if (!didStartDebug) {
                                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🚫 Failed to debug with Mozilla Firefox.\n` } });
                                }
                            }
                            catch (e) {
                                this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🚫 Failed to debug with Mozilla Firefox: ${e}\n` } });
                            }
                        }
                        else if (this.debugConfiguration.attachOptions.action === "debugWithEdge") {
                            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🔍 Debugging with Microsoft Edge (${url}).\n` } });

                            try {
                                const didStartDebug = await debug.startDebugging(this.debugSession.workspaceFolder, {
                                    name: '.NET Stalker: Edge',
                                    type: 'msedge',
                                    request: 'launch',
                                    url: url,
                                    webRoot: this.debugConfiguration.webRoot,
                                    ...this.debugConfiguration.attachOptions.browserTaskProperties
                                }, this.debugSession);

                                if (!didStartDebug) {
                                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🚫 Failed to debug with Microsoft Edge.\n` } });
                                }
                            }
                            catch (e) {
                                this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🚫 Failed to debug with Microsoft Edge: ${e}\n` } });
                            }
                        }
                    }
                }
                else {
                    this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: '🚫 Failed to attach to child process. Stopping debugger.\n' } });

                    this.stopWatching(true); // full stop
                    return;
                }
            }

            this.restartCheckProcessesTimeout(this.debugConfiguration.watchOptions.interval ?? StalkerDebugAdapter.DefaultIntervalMs); // (most likely) slows down the interval
            return;
        }, timeoutMs);
    }

    private async startDebugging(): Promise<void> {
        this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: '🚀 Starting .NET Stalker Debugger.\n' } });

        if (!await this.startPreBuildTasks()) return;

        await this.startDotNetWatch();

        this.startCheckProcessesTimeout(this.debugConfiguration.attachOptions.interval ?? (StalkerDebugAdapter.DefaultIntervalMs / 2));
    }

    private async startDotNetWatch(): Promise<void> {
        if (this.dotNetWatchTask) throw new Error('dotnet watch is already running'); // ! this should never happen

        const dotNetWatchArgs = this.debugConfiguration.watchOptions.args && this.debugConfiguration.watchOptions.args.length > 0 ? ` ${this.debugConfiguration.watchOptions.args.join(' ')}` : '';
        const childDotNetProcessArgs = this.debugConfiguration.processOptions.args && this.debugConfiguration.processOptions.args.length > 0 ? " -- " + this.debugConfiguration.processOptions.args.join(' ') : '';

        let profileArg = "--no-launch-profile";
        if (this.debugConfiguration.launchSettingsProfile) profileArg = `--launch-profile ${this.debugConfiguration.launchSettingsProfile}`;
        else if (this.debugConfiguration.processOptions.launchSettingsProfile) profileArg = `--launch-profile ${this.debugConfiguration.processOptions.launchSettingsProfile}`;

        const urls = await this.getLaunchUrls();
        const urlsArg = urls.length > 0 ? ` --urls="${urls.join(";")}"` : "";

        const verboseArg = this.debugConfiguration.watchOptions.verbose ? ' --verbose' : "";

        const commandLine = `${this.debugConfiguration.watchOptions.dotnet} watch run ${profileArg}${verboseArg}${dotNetWatchArgs} --project "${this.debugConfiguration.project}"${urlsArg}${childDotNetProcessArgs}`;
        const shellExec = new ShellExecution(commandLine, { cwd: this.debugConfiguration.cwd, env: this.debugConfiguration.env });

        const task = new Task({ type: 'process' }, TaskScope.Workspace, '.NET Stalker Watch', '.NET Stalker', shellExec, "stalker");
        task.isBackground = true;

        this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: '⌚️ Starting .NET Watch task.\n' } });

        this.dotNetWatchTask = await tasks.executeTask(task);
    }

    /**
     * @returns If task is waited for and has ended, the exit code if the task completed or undefined if it was terminated. If task is not waited for, false.
     */
    private async startPreBuildTask(preBuildTask: PreBuildTask): Promise<number | false | undefined> {
        const shellExec = new ShellExecution(preBuildTask.commandLine, { cwd: preBuildTask.cwd ?? this.debugConfiguration.cwd, env: this.debugConfiguration.env });

        const task = new Task({ type: 'process' }, TaskScope.Workspace, `.NET Stalker Task: ${preBuildTask.name}`, '.NET Stalker', shellExec);
        task.isBackground = preBuildTask.isBackground ?? false;
        if (preBuildTask.problemMatcher) task.problemMatchers = [preBuildTask.problemMatcher];

        this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: `🔨 Starting pre-build task: ${preBuildTask.name}\n` } });

        const preBuildTaskExecution = this.preBuildTasks[preBuildTask.name] = { definition: preBuildTask, task: await tasks.executeTask(task) };

        return preBuildTask.waitFor ? this.waitForPreBuildTask(preBuildTaskExecution) : false;
    }

    /**
     * @returns If any tasks to be waited for returns a non-zero exit code or debugger is stopping, false. Otherwise, true.
     */
    private async startPreBuildTasks(): Promise<boolean> {
        if (!this.debugConfiguration.buildOptions.preBuildTasks || this.debugConfiguration.buildOptions.preBuildTasks.length === 0) return true;

        for (const preBuildTask of this.debugConfiguration.buildOptions.preBuildTasks!) {
            if (this.debuggerIsStopping) return false;

            // set defaults
            if (preBuildTask.failOnNonZeroExitCode === undefined) preBuildTask.failOnNonZeroExitCode = true;
            if (preBuildTask.isBackground === undefined) preBuildTask.isBackground = false;
            if (preBuildTask.waitFor === undefined) preBuildTask.waitFor = true;

            const startPreBuildTaskResult = await this.startPreBuildTask(preBuildTask);
            if (preBuildTask.waitFor && preBuildTask.failOnNonZeroExitCode && startPreBuildTaskResult !== 0) return false; // ! full stop is handled in `tasks.onDidEndTaskProcess` in constructor
        }

        return true;
    }

    private stopCheckProcessesTimeout(): void {
        if (this.checkProcessesTimeout) {
            clearInterval(this.checkProcessesTimeout);
            this.checkProcessesTimeout = undefined;
        }
    }

    private stopDotNetWatchTask(): void {
        if (this.dotNetWatchTask) {
            this.dotNetWatchTask.terminate();
            this.dotNetWatchTask = undefined;
        }
    }

    private stopPreBuildTasks(): void {
        for (const preBuildTask of Object.values(this.preBuildTasks)) {
            preBuildTask.task?.terminate();
            preBuildTask.task = undefined;
            delete this.preBuildTasks[preBuildTask.definition.name];
        }
    }

    private stopWatching(stopDebugging: boolean): void {
        if (this.debuggerIsStopping) return;
        this.debuggerIsStopping = true;

        this.stopCheckProcessesTimeout();
        this.stopPreBuildTasks();
        this.stopDotNetWatchTask();

        if (stopDebugging) {
            this.sendMessage.fire({ type: 'event', event: 'output', body: { category: 'console', output: '🛑 Stopping .NET Stalker Debugger.\n' } });
            debug.stopDebugging(this.debugSession);
        }
    }

    private async waitForPreBuildTask(preBuildTaskExecution: PreBuildTaskExecution): Promise<number | undefined> {
        return await new Promise<number | undefined>(resolve => {
            const interval = setInterval(() => {
                const preBuildTask = this.preBuildTasks[preBuildTaskExecution.definition.name];
                if (preBuildTask?.hasEnded) {
                    clearInterval(interval);
                    resolve(preBuildTask.exitCode);
                }
            }, 100);
        });
    }
}
