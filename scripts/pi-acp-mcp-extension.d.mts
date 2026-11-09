export interface PiMcpRegistration {
  registerMcpServer(name: string, config: Record<string, unknown>): void;
}
export function registerPiMcpServers(api: PiMcpRegistration, servers: unknown[]): void;
export default function register(api: PiMcpRegistration): void;
