import fs = require('fs-extra');
import reflect = require('jsii-reflect');
import spec = require('jsii-spec');
import log4js = require('log4js');
import yargs = require('yargs');
import { compareAssemblies } from '../lib';
import { DownloadFailure, downloadNpmPackage, showDownloadFailure } from '../lib/util';
import { VERSION } from '../lib/version';

const LOG = log4js.getLogger('jsii-diff');

async function main(): Promise<number> {
  const argv = yargs
      .env('JSII_DIFF')
      .option('verbose', { alias: 'v', type: 'count', desc: 'Increase the verbosity of output', global: true })
      // tslint:disable-next-line:max-line-length
      .option('default-stability', { alias: 's', type: 'string', choices: ['experimental', 'stable'], desc: 'Treat unmarked APIs as', default: 'stable' })
      .usage('$0 <original> [updated]', 'Compare two JSII assemblies.', args => args
        .positional('original', {
          description: 'Original assembly (file, package or "npm:package@version")',
          type: 'string'
        })
        .positional('updated', {
          description: 'New assembly (file, package or "npm:package@version")',
          type: 'string',
          default: '.'
        })
      )
      .help()
      .version(VERSION)
      .argv;

  configureLog4js(argv.verbose);

  LOG.debug(`Loading original assembly from ${(argv as any).original}`);
  const loadOriginal = await loadAssembly((argv as any).original);
  if (!loadOriginal.success) {
    process.stderr.write(`Could not load '${loadOriginal.resolved}': ${showDownloadFailure(loadOriginal.reason)}. Skipping analysis\n`);
    return 0;
  }

  LOG.debug(`Loading updated assembly from ${(argv as any).updated}`);
  const loadUpdated = await loadAssembly((argv as any).updated);
  if (!loadUpdated.success) {
    process.stderr.write(`Could not load '${loadUpdated.resolved}': ${showDownloadFailure(loadUpdated.reason)}. Skipping analysis\n`);
    return 0;
  }

  const original = loadOriginal.assembly;
  const updated = loadUpdated.assembly;

  if (original.name !== updated.name) {
    process.stderr.write(`Look like different assemblies: '${original.name}' vs '${updated.name}'. Comparing is probably pointless...\n`);
  }

  LOG.info(`Starting analysis`);
  const mismatches = compareAssemblies(original, updated, {
    defaultExperimental: argv["default-stability"] === 'experimental'
  });

  LOG.info(`Found ${mismatches.count} issues`);

  if (mismatches.count > 0) {
    process.stderr.write(`Original assembly: ${original.name}@${original.version}\n`);
    process.stderr.write(`Updated assembly:  ${updated.name}@${updated.version}\n`);
    process.stderr.write(`API elements with incompatible changes:\n`);
    for (const msg of mismatches.messages()) {
      process.stderr.write(`- ${msg}\n`);
    }

    return 1;
  }

  return 0;
}

// Allow both npm:<package> (legacy) and npm://<package> (looks better)
const NPM_REGEX = /^npm:(\/\/)?/;

/**
 * Load the indicated assembly from the given name
 *
 * Supports downloading from NPM as well as from file or directory.
 */
async function loadAssembly(requested: string): Promise<LoadAssemblyResult> {
  let resolved = requested;
  try {
    if (requested.match(NPM_REGEX)) {
      let pkg = requested.replace(NPM_REGEX, '');
      if (!pkg) { pkg = await loadPackageNameFromAssembly(); }

      resolved = `npm://${pkg}`;
      if (pkg.indexOf('@', 1) === -1) { resolved += '@latest'; }

      const download = await downloadNpmPackage(pkg, loadFromFilesystem);
      if (download.success) {
        return { requested, resolved, success: true, assembly: download.result };
      }
      return { requested, resolved, success: false, reason: download.reason };
    } else {
      // We don't accept failure loading from the filesystem
      return { requested, resolved, success: true, assembly: await loadFromFilesystem(requested) };
    }
  } catch (e) {
    // Prepend information about which assembly we've failed to load
    //
    // Look at the type of error. If it has a lot of lines (like validation errors
    // tend to do) log everything to the debug log and only show a couple
    const maxLines = 3;
    const messageWithContext = `Error loading assembly '${resolved}': ${e.message}`;
    const errorLines = messageWithContext.split('\n');
    if (errorLines.length < maxLines) { throw new Error(messageWithContext); }
    for (const line of errorLines) {
      LOG.info(line);
    }
    throw new Error([...errorLines.slice(0, maxLines), '...'].join('\n'));
  }
}

type LoadAssemblyResult = { requested: string; resolved: string }
    & ({ success: true; assembly: reflect.Assembly } | { success: false; reason: DownloadFailure });

async function loadPackageNameFromAssembly(): Promise<string> {
  const JSII_ASSEMBLY_FILE = '.jsii';
  if (!await fs.pathExists(JSII_ASSEMBLY_FILE)) {
    throw new Error(`No NPM package name given and no ${JSII_ASSEMBLY_FILE} file in the current directory. Please specify a package name.`);
  }
  const module = spec.validateAssembly(await fs.readJSON(JSII_ASSEMBLY_FILE, { encoding: 'utf-8' }));
  if (!module.name) { throw new Error(`Could not find package in ${JSII_ASSEMBLY_FILE}`); }

  return module.name;
}

async function loadFromFilesystem(name: string) {
  const stat = await fs.stat(name);

  const ts = new reflect.TypeSystem();
  if (stat.isDirectory()) {
    return await ts.loadModule(name);
  } else {
    return await ts.loadFile(name);
  }
}

main().then(n => {
  process.exit(n);
}).catch(e => {
  // tslint:disable-next-line:no-console
  console.error(e);
  process.exit(100);
});

function configureLog4js(verbosity: number) {
    log4js.configure({
        appenders: {
            console: {
                type: 'stderr',
                layout: { type: 'colored' }
            },
        },
        categories: {
            default: { appenders: ['console'], level: _logLevel() },
        }
    });

    function _logLevel(): keyof log4js.Levels {
        switch (verbosity) {
        case 0: return 'WARN';
        case 1: return 'INFO';
        case 2: return 'DEBUG';
        case 3: return 'TRACE';
        default: return 'ALL';
        }
    }
}