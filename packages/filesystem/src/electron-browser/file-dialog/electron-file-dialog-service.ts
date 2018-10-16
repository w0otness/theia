/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
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

import { injectable } from 'inversify';
import { remote, FileFilter, OpenDialogOptions, SaveDialogOptions } from 'electron';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/node/file-uri'; // We are OK to use this here.
import { MaybeArray } from '@theia/core/lib/common/types';
import { FileStat } from '../../common';
import { DefaultFileDialogService, OpenFileDialogProps, SaveFileDialogProps } from '../../browser/file-dialog';

@injectable()
export class ElectronFileDialogService extends DefaultFileDialogService {

    async showOpenDialog(props: OpenFileDialogProps & { canSelectMany: true }, folder?: FileStat): Promise<MaybeArray<URI> | undefined>;
    async showOpenDialog(props: OpenFileDialogProps, folder?: FileStat): Promise<URI | undefined>;
    async showOpenDialog(props: OpenFileDialogProps, folder?: FileStat): Promise<MaybeArray<URI> | undefined> {
        const rootNode = await this.getRootNode(folder);
        if (rootNode) {
            return new Promise<MaybeArray<URI> | undefined>(resolve => {
                remote.dialog.showOpenDialog(this.toOpenDialogOptions(rootNode.uri, props), (filePaths: string[] | undefined) => {
                    if (!filePaths || filePaths.length === 0) {
                        resolve(undefined);
                        return;
                    }
                    resolve(filePaths.map(path => FileUri.create(path)));
                });
            });
        }
        return undefined;
    }

    async showSaveDialog(props: SaveFileDialogProps, folder?: FileStat): Promise<URI | undefined> {
        const rootNode = await this.getRootNode(folder);
        if (rootNode) {
            return new Promise<URI | undefined>(resolve => {
                remote.dialog.showSaveDialog(this.toSaveDialogOptions(rootNode.uri, props), (filename: string | undefined) => {
                    if (!filename) {
                        resolve(undefined);
                        return;
                    }
                    resolve(FileUri.create(filename));
                });
            });
        }
        return undefined;
    }

    protected toDialogOptions(uri: URI, props: SaveFileDialogProps | OpenFileDialogProps): electron.FileDialogProps {
        const { title } = props;
        const defaultPath = FileUri.fsPath(uri);
        const filters: FileFilter[] = [];
        if (props.filters) {
            filters.push(...Object.keys(props.filters).map(key => ({ name: key, extensions: props.filters![key] })));
        }
        return { title, defaultPath, filters };
    }

    protected toOpenDialogOptions(uri: URI, props: OpenFileDialogProps): OpenDialogOptions {
        const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [];
        // Note: On Windows and Linux an open dialog can not be both a file selector and a directory selector,
        // so if you set properties to ['openFile', 'openDirectory'] on these platforms, a directory selector will be shown.
        if (props.canSelectFiles !== false && props.canSelectFolders !== true) {
            properties.push('openFile');
        }
        if (props.canSelectFolders === true && props.canSelectFiles === false) {
            properties.push('openDirectory');
        }
        if (props.canSelectMany === true) {
            properties.push('multiSelections');
        }
        const buttonLabel = props.openLabel;
        return { ...this.toDialogOptions(uri, props), properties, buttonLabel };
    }

    protected toSaveDialogOptions(uri: URI, props: SaveFileDialogProps): SaveDialogOptions {
        const buttonLabel = props.saveLabel;
        return { ...this.toDialogOptions(uri, props), buttonLabel };
    }

}

export namespace electron {

    /**
     * Common "super" interface of the `electron.SaveDialogOptions` and `electron.OpenDialogOptions` types.
     */
    export interface FileDialogProps {

        /**
         * The dialog title.
         */
        readonly title?: string;

        /**
         * The default path, where the dialog opens. Requires an FS path.
         */
        readonly defaultPath?: string;

        /**
         * Resource filter.
         */
        readonly filters?: FileFilter[];

    }
}
