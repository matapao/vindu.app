/** The environment a test launches Electron with: this process's and the test's own, without ELECTRON_RUN_AS_NODE.
 *  An editor's terminal passes it on (VS Code is itself Electron), and Electron started with it runs as plain Node. */
export function launchEnv(own: Record<string, string>): Record<string, string> {
  const { ELECTRON_RUN_AS_NODE: _asNode, ...inherited } = process.env;
  return { ...(inherited as Record<string, string>), ...own };
}
