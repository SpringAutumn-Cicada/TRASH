import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { libraryLogicalPath } from '@trash/protocol';

export const libraryLayoutMarker = '.trash/library-layout.json';
export const libraryFolders = {
  'literature':'library/literature',
  'abstract-library':'library/abstract_library',
  'knowledge_base':'library/knowledge_base'
} as const;

export function libraryLayoutEnabled(root:string):boolean {
  try { return lstatSync(join(root,libraryLayoutMarker)).isFile(); }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; return false; }
}

export function consolidatedLibraryPath(path:string):string {
  const logical=libraryLogicalPath(path);
  const head=logical.split('/',1)[0];
  return Object.hasOwn(libraryFolders,head)
    ?libraryFolders[head as keyof typeof libraryFolders]+logical.slice(head.length)
    :path;
}

export function projectLibraryPath(root:string,path:string):string {
  return libraryLayoutEnabled(root)?consolidatedLibraryPath(path):libraryLogicalPath(path);
}
