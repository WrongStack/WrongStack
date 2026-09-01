export interface PublishablePackage {
  name: string;
  version: string;
  dir: string;
  access: string | undefined;
  provenance: boolean;
  workspaceDeps: string[];
}

export function workspaceMemberDirs(root?: string): string[];

export function collectPublishablePackages(root?: string): {
  publishable: PublishablePackage[];
  skipped: string[];
};

export function layerByDependencies(packages: readonly PublishablePackage[]): {
  layers: PublishablePackage[][];
  cycles: string[];
};
