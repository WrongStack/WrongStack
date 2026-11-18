export interface Document {
  content: string;
  saved: string;
  binary: boolean;
  tooLarge: boolean;
  image?: string;
  editing: boolean;
}

export type Action = {
  kind:
    | 'file'
    | 'directory'
    | 'rename'
    | 'move'
    | 'delete'
    | 'close'
    | 'conflict'
    | 'discard'
    | 'commit'
    | 'comment';
  path: string;
  line?: number;
  /** Disk version shown in a conflict review; overwrite replaces only this version. */
  sha256?: string;
};
