import { Range, Color, Location, Position } from 'vscode-languageserver/node';
import * as fs from 'fs';
import fastGlob from 'fast-glob';
import * as culori from 'culori';
import axios from 'axios';
import postcss from 'postcss';
import { pathToFileURL } from 'url';

import CacheManager from './CacheManager';
import isColor from './utils/isColor';
import { culoriColorToVscodeColor } from './utils/culoriColorToVscodeColor';

export type CSSSymbol = {
  name: string
  value: string
}

export type CSSVariable = {
  symbol: CSSSymbol
  definition: Location
  color?: Color
}

export interface CSSVariablesSettings {
  lookupFiles: string[]
  blacklistFolders: string[]
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
export const defaultSettings: CSSVariablesSettings = {
  lookupFiles: ['**/*.less', '**/*.scss', '**/*.sass', '**/*.css'],
  blacklistFolders: [
    '**/.git',
    '**/.svn',
    '**/.hg',
    '**/CVS',
    '**/.DS_Store',
    '**/node_modules',
    '**/bower_components',
    '**/tmp',
    '**/dist',
    '**/tests',
  ],
};

export default class CSSVariableManager {
  private cacheManager = new CacheManager<CSSVariable>();

  public parseCSSVariablesFromText = async ({
    content,
    filePath,
  }: {
    content: string
    filePath: string
  }) => {
    try {
      // reset cache for this file
      this.cacheManager.clearFileCache(filePath);
      const ast = postcss.parse(content);
      const fileURI = pathToFileURL(filePath).toString();

      const importUrls = [];
      ast.walkAtRules((atRule) => {
        if (atRule.name === 'import') {
          // only support absolute url for now
          const match = atRule.params.match(
            /['"](?<protocol>http|https):\/\/(?<url>.*?)['"]/
          );

          if (match) {
            const url = `${match.groups.protocol}://${match.groups.url}`;
  
            importUrls.push(url);
          }
        }
      });

      await Promise.all(
        importUrls.map(async (url) => {
          try {
            const response = await axios(url, {
              responseType: "text"
            });

            const cssText = await response.data;

            return this.parseCSSVariablesFromText({
              content: cssText,
              filePath: url,
            });
          } catch (err) {
            console.log(err, `cannot fetch data from ${url}`);
          }
        })
      );

      ast.walkDecls((decl) => {
        if (decl.prop.startsWith('--')) {
          const variable: CSSVariable = {
            symbol: {
              name: decl.prop,
              value: decl.value,
            },
            definition: {
              uri: fileURI,
              range: Range.create(
                Position.create(
                  decl.source.start.line,
                  decl.source.start.column
                ),
                Position.create(decl.source.end.line, decl.source.end.column)
              ),
            },
          };

          if (isColor(decl.value)) {
            const culoriColor = culori.parse(decl.value);
            if (culoriColor) {
              variable.color = culoriColorToVscodeColor(culoriColor);
            }
          }

          // add to cache
          this.cacheManager.set(filePath, decl.prop, variable);
        }
      });
    } catch (error) {
      console.error(error);
    }
  };

  public parseAndSyncVariables = async (
    workspaceFolders: string[],
    settings = defaultSettings
  ) => {
    for (const folderPath of workspaceFolders) {
      await fastGlob(settings.lookupFiles, {
        onlyFiles: true,
        cwd: folderPath,
        ignore: settings.blacklistFolders,
        absolute: true,
      }).then((files) => {
        return Promise.all(
          files.map((filePath) => {
            const content = fs.readFileSync(filePath, 'utf8');
            return this.parseCSSVariablesFromText({
              content,
              filePath,
            });
          })
        );
      });
    }
  };

  public getAll() {
    return this.cacheManager.getAll();
  }

  public clearFileCache(filePath: string) {
    this.cacheManager.clearFileCache(filePath);
  }

  public clearAllCache() {
    this.cacheManager.clearAllCache();
  }
}