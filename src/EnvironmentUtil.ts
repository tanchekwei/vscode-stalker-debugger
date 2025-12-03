import { StalkerDebugConfiguration } from "./StalkerDebugConfiguration";

export class EnvironmentUtil {
    static readonly pathDelimiter = process.platform === 'win32' ? '\\' : '/';
    static readonly platform = process.platform;

    static getProjectProcess(processes: ProcessInfo[], processFileName: string): ProcessInfo | undefined {
        return this.platform === 'win32'
            ? (processes.length === 1 ? processes[0] : undefined)
            : processes.find(p => p.bin?.endsWith(`/${processFileName}`) === true);
    }

    static modifyPath(path: string): string {
        switch (this.platform) {
            case 'darwin': return path.replace(/\\/g, '/');
            case 'linux': return path.replace(/\\/g, '/');
            case 'win32': return path.replace(/\//g, '\\');
            default: return path;
        }
    }

    static modifyPaths(launchConfig: StalkerDebugConfiguration): void {
        launchConfig.cwd = this.modifyPath(launchConfig.cwd);
        launchConfig.process = this.modifyPath(launchConfig.process);
        launchConfig.project = this.modifyPath(launchConfig.project);

        if (launchConfig.webRoot) launchConfig.webRoot = this.modifyPath(launchConfig.webRoot);

        if (launchConfig.vars.projectDir) launchConfig.vars.projectDir = this.modifyPath(launchConfig.vars.projectDir);
    }

    static processFileName(processFileName: string): string {
        return this.platform === 'win32' ? processFileName.replace(/\.dll$/i, "") + ".exe" : processFileName;
    }
}

export type ProcessInfo = {
    bin?: string;
    cmd: string;
    gid?: number;
    name: string;
    pid: number;
    ppid?: number;
    uid?: number;
};