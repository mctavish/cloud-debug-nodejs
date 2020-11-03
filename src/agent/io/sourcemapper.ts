// Copyright 2016 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs';
import pLimit = require('p-limit');
import * as path from 'path';
import {promisify} from 'util';
import * as sourceMap from 'source-map';

import * as utils from '../util/utils';

const CONCURRENCY = 10;
const WEBPACK_PREFIX = 'webpack://';
const readFilep = promisify(fs.readFile);

/** @define {string} */ const MAP_EXT = '.map';

export interface MapInfoInput {
  outputFile: string;
  mapFile: string;
  mapConsumer: sourceMap.RawSourceMap;
  // the sources are in ascending order from
  // shortest to longest
  sources: string[];
}

export interface MapInfoOutput {
  file: string;
  line: number;
  column: number;
}

/** Interfaces pulled from source-map-support. */
interface Position {
  source: string;
  line: number;
  column: number;
}

interface UrlAndMap {
  url: string;
  map: string | Buffer;
}

interface SourceMapSupport {
  retrieveSourceMap(source: string): UrlAndMap | null;
}

/**
 * @param {!Map} infoMap The map that maps input source files to
 *  SourceMapConsumer objects that are used to calculate mapping information
 * @param {string} mapPath The path to the sourcemap file to process.  The
 *  path should be relative to the process's current working directory
 * @private
 */
async function processSourcemap(
  infoMap: Map<string, MapInfoInput>,
  mapPath: string
) {
  // this handles the case when the path is undefined, null, or
  // the empty string
  if (!mapPath || !mapPath.endsWith(MAP_EXT)) {
    throw new Error(`The path ${mapPath} does not specify a sourcemap file`);
  }
  mapPath = path.normalize(mapPath);

  let contents;
  try {
    contents = await readFilep(mapPath, 'utf8');
  } catch (e) {
    throw new Error('Could not read sourcemap file ' + mapPath + ': ' + e);
  }

  let consumer: sourceMap.RawSourceMap;
  try {
    // TODO: Determine how to reconsile the type conflict where `consumer`
    //       is constructed as a SourceMapConsumer but is used as a
    //       RawSourceMap.
    // TODO: Resolve the cast of `contents as any` (This is needed because the
    //       type is expected to be of `RawSourceMap` but the existing
    //       working code uses a string.)
    consumer = (new sourceMap.SourceMapConsumer(
      (contents as {}) as sourceMap.RawSourceMap
    ) as {}) as sourceMap.RawSourceMap;
  } catch (e) {
    throw new Error(
      'An error occurred while reading the ' +
        'sourcemap file ' +
        mapPath +
        ': ' +
        e
    );
  }

  /*
   * If the sourcemap file defines a "file" attribute, use it as
   * the output file where the path is relative to the directory
   * containing the map file.  Otherwise, use the name of the output
   * file (with the .map extension removed) as the output file.
   */
  const outputBase = consumer.file
    ? consumer.file
    : path.basename(mapPath, '.map');
  const parentDir = path.dirname(mapPath);
  const outputPath = path.normalize(path.join(parentDir, outputBase));

  // the sources are in ascending order from shortest to longest
  const nonemptySources = consumer.sources
    .filter(val => !!val)
    .sort((src1, src2) => src1.length - src2.length);

  const normalizedSources = nonemptySources
    .map((src: string) => {
      if (src.toLowerCase().startsWith(WEBPACK_PREFIX)) {
        return src.substring(WEBPACK_PREFIX.length);
      }
      return src;
    })
    .map((relPath: string) => {
      // resolve the paths relative to the map file so that
      // they are relative to the process's current working
      // directory
      return path.normalize(path.join(parentDir, relPath));
    });

  if (normalizedSources.length === 0) {
    throw new Error('No sources listed in the sourcemap file ' + mapPath);
  }
  for (const src of normalizedSources) {
    infoMap.set(path.normalize(src), {
      outputFile: outputPath,
      mapFile: mapPath,
      mapConsumer: consumer,
      sources: nonemptySources,
    });
  }
}

export class SourceMapper {
  infoMap: Map<string, MapInfoInput>;

  /**
   * @param {Array.<string>} sourcemapPaths An array of paths to .map sourcemap
   *  files that should be processed.  The paths should be relative to the
   *  current process's current working directory
   * @param {Logger} logger A logger that reports errors that occurred while
   *  processing the given sourcemap files
   * @constructor
   */
  constructor() {
    this.infoMap = new Map();
  }

  /**
   * Used to get the information about the transpiled file from a given input
   * source file provided there isn't any ambiguity with associating the input
   * path to exactly one output transpiled file.
   *
   * @param inputPath The (possibly relative) path to the original source file.
   * @return The `MapInfoInput` object that describes the transpiled file
   *  associated with the specified input path.  `null` is returned if either
   *  zero files are associated with the input path or if more than one file
   *  could possibly be associated with the given input path.
   */
  private getMappingInfo(inputPath: string): MapInfoInput | null {
    if (this.infoMap.has(path.normalize(inputPath))) {
      return this.infoMap.get(inputPath) as MapInfoInput;
    }

    const matches = utils.findScriptsFuzzy(
      inputPath,
      Array.from(this.infoMap.keys())
    );
    if (matches.length === 1) {
      return this.infoMap.get(matches[0]) as MapInfoInput;
    }

    return null;
  }

  /**
   * Used to determine if the source file specified by the given path has
   * a .map file and an output file associated with it.
   *
   * If there is no such mapping, it could be because the input file is not
   * the input to a transpilation process or it is the input to a transpilation
   * process but its corresponding .map file was not given to the constructor
   * of this mapper.
   *
   * @param {string} inputPath The path to an input file that could
   *  possibly be the input to a transpilation process.  The path should be
   *  relative to the process's current working directory.
   */
  hasMappingInfo(inputPath: string): boolean {
    return this.getMappingInfo(inputPath) !== null;
  }

  /**
   * @param {string} inputPath The path to an input file that could possibly
   *  be the input to a transpilation process.  The path should be relative to
   *  the process's current working directory
   * @param {number} lineNumber The line number in the input file where the line number is
   *   zero-based.
   * @param {number} colNumber The column number in the line of the file
   *   specified where the column number is zero-based.
   * @return {Object} The object returned has a "file" attribute for the
   *   path of the output file associated with the given input file (where the
   *   path is relative to the process's current working directory),
   *   a "line" attribute of the line number in the output file associated with
   *   the given line number for the input file, and an optional "column" number
   *   of the column number of the output file associated with the given file
   *   and line information.
   *   Line and column will be zero-based.
   *
   *   If the given input file does not have mapping information associated
   *   with it then null is returned.
   */
  mappingInfo(
    inputPath: string,
    lineNumber: number,
    colNumber: number
  ): MapInfoOutput | null {
    inputPath = path.normalize(inputPath);
    const entry = this.getMappingInfo(inputPath);
    if (entry === null) {
      return null;
    }

    const relPath = path
      .relative(path.dirname(entry.mapFile), inputPath)
      .replace(/\\/g, '/');

    /**
     * Note: Since `entry.sources` is in ascending order from shortest
     *       to longest, the first source path that ends with the
     *       relative path is necessarily the shortest source path
     *       that ends with the relative path.
     */
    let source: string | undefined;
    for (const src of entry.sources) {
      if (src.endsWith(relPath)) {
        source = src;
        break;
      }
    }

    const sourcePos = {
      source: source || relPath,
      line: lineNumber + 1, // the SourceMapConsumer expects the line number
      // to be one-based but expects the column number
      column: colNumber, // to be zero-based
    };

    // TODO: Determine how to remove the explicit cast here.
    const consumer: sourceMap.SourceMapConsumer = (entry.mapConsumer as {}) as sourceMap.SourceMapConsumer;
    const allPos = consumer.allGeneratedPositionsFor(sourcePos);
    /*
     * Based on testing, it appears that the following code is needed to
     * properly get the correct mapping information.
     *
     * In particular, the generatedPositionFor() alone doesn't appear to
     * give the correct mapping information.
     */
    const mappedPos: sourceMap.Position =
      allPos && allPos.length > 0
        ? allPos.reduce((accumulator, value) => {
            return value.line < accumulator.line ? value : accumulator;
          })
        : consumer.generatedPositionFor(sourcePos);

    return {
      file: entry.outputFile,
      line: mappedPos.line - 1, // convert the one-based line numbers returned
      // by the SourceMapConsumer to the expected
      // zero-based output.
      // TODO: The `sourceMap.Position` type definition has a `column`
      //       attribute and not a `col` attribute.  Determine if the type
      //       definition or this code is correct.
      column: ((mappedPos as {}) as {col: number}).col || 0, // SourceMapConsumer uses
      // zero-based column numbers which is the same as the expected output
    };
  }

  /**
   * Require and return the 'source-map-support' module if it is already present.  Otherwise, return null.
   */
  safeRequireSourceMapSupport(): SourceMapSupport | null {
    return utils.safeRequire('source-map-support') as SourceMapSupport;
  }

  /**
   * Returns true if a sourcemap is available via source-map-support for the specified file.
   */
  canMapViaSourceMapSupport(inputPath: string): boolean {
    const sms = this.safeRequireSourceMapSupport();
    if (!sms) {
      return false;
    }
    const sourceMap = sms.retrieveSourceMap(inputPath);
    return sourceMap !== null;
  }

  /**
   * Maps a location from a source file & location to the location that exists in node memory.
   * Returns null if 'source-map-support' is not available.
   * @param inputPath full path for the file that has been transpiled
   * @param lineNumber 0-indexed line number in the source file
   * @param colNumber 0-indexed column number in the source file.
   */
  mapViaSourceMapSupport(
    inputPath: string,
    lineNumber: number,
    colNumber: number
  ): MapInfoOutput | null {
    const sms = this.safeRequireSourceMapSupport();
    if (sms) {
      const inputPosition: Position = {
        source: inputPath,
        line: lineNumber + 1, // 1-indexed line number is expected
        column: colNumber, // 0-indexed.
      };

      const rawMap = sms.retrieveSourceMap(inputPath);
      const consumer = new sourceMap.SourceMapConsumer(
        (rawMap!.map as unknown) as sourceMap.RawSourceMap
      );
      const allPos = consumer.allGeneratedPositionsFor(inputPosition);
      const mappedPos: sourceMap.Position =
        allPos && allPos.length > 0
          ? allPos.reduce((accumulator, value) => {
              return value.line < accumulator.line ? value : accumulator;
            })
          : consumer.generatedPositionFor(inputPosition);

      return {
        file: inputPath,
        line: mappedPos.line - 1, // map back to 0-indexed output.
        column: mappedPos.column,
      };
    }
    return null;
  }
}

export async function create(sourcemapPaths: string[]): Promise<SourceMapper> {
  const limit = pLimit(CONCURRENCY);
  const mapper = new SourceMapper();
  const promises = sourcemapPaths.map(path =>
    limit(() => processSourcemap(mapper.infoMap, path))
  );
  try {
    await Promise.all(promises);
  } catch (err) {
    throw new Error(
      'An error occurred while processing the sourcemap files' + err
    );
  }
  return mapper;
}
