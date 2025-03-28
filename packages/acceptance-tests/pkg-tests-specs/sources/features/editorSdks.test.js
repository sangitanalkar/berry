import {npath, ppath, xfs} from '@yarnpkg/fslib';
import {spawn}             from 'child_process';
import {tests}             from 'pkg-tests-core';

describe(`Features`, () => {
  describe(`Editor SDK`, () => {
    test(
      `it should allow non-PnP Node to access the binary under a PnP environment`,
      makeTemporaryEnv({
        dependencies: {
          [`eslint`]: `file:./my-eslint`,
        },
      }, async ({path, run, source}) => {
        const binPath = ppath.join(path, `my-eslint/bin/eslint.js`);
        const manifestPath = ppath.join(path, `my-eslint/package.json`);

        await xfs.mkdirpPromise(ppath.dirname(binPath));
        await xfs.writeFilePromise(binPath, `console.log(JSON.stringify({wrapper: require('no-deps')}))`);

        await xfs.mkdirpPromise(ppath.dirname(manifestPath));
        await xfs.writeJsonPromise(manifestPath, {
          name: `eslint`,
          version: `1.0.0`,
          bin: `./bin/eslint.js`,
          dependencies: {
            [`no-deps`]: `1.0.0`,
          },
        });

        await run(`install`);
        await sdks([`base`], path);

        const rawOutput = await noPnpNode([`./.yarn/sdks/eslint/bin/eslint.js`], path);
        const jsonOutput = JSON.parse(rawOutput);

        expect(jsonOutput).toMatchObject({
          wrapper: {
            name: `no-deps`,
            version: `1.0.0`,
          },
        });
      }),
    );

    test(
      `it shouldn't break under non-PnP installs`,
      makeTemporaryEnv({
        dependencies: {
          [`eslint`]: `file:./my-eslint`,
        },
      }, async ({path, run, source}) => {
        const binPath = ppath.join(path, `my-eslint/bin/eslint.js`);
        const manifestPath = ppath.join(path, `my-eslint/package.json`);

        await xfs.mkdirpPromise(ppath.dirname(binPath));
        await xfs.writeFilePromise(binPath, `console.log(JSON.stringify({wrapper: require('no-deps')}))`);

        await xfs.mkdirpPromise(ppath.dirname(manifestPath));
        await xfs.writeJsonPromise(manifestPath, {
          name: `eslint`,
          version: `1.0.0`,
          bin: `./bin/eslint.js`,
          dependencies: {
            [`no-deps`]: `1.0.0`,
          },
        });

        await run(`install`);
        await sdks([`base`], path);

        await run(`install`, {nodeLinker: `node-modules`});
        expect(xfs.existsSync(ppath.join(path, `.pnp.cjs`))).toEqual(false);

        const rawOutput = await noPnpNode([`./.yarn/sdks/eslint/bin/eslint.js`], path);
        const jsonOutput = JSON.parse(rawOutput);

        expect(jsonOutput).toMatchObject({
          wrapper: {
            name: `no-deps`,
            version: `1.0.0`,
          },
        });
      }),
    );

    /**
     * Example messages matching '/\.zip\\//' within "send(msg)" - https://hastebin.com/zosibaseki
     * Note that no messages were found matching '/^zip:\\/\\//' were found within "onMessage(message)"
     */
    test(
      `it should patch message into VSCode typescript language extension for zip schemes`,
      async () => {
        const child = spawn(process.execPath, [require.resolve(`@yarnpkg/monorepo/.yarn/sdks/typescript/lib/tsserver.js`)], {
          cwd: npath.dirname(require.resolve(`@yarnpkg/monorepo/package.json`)),
          stdio: `pipe`,
          encoding: `utf8`,
        });

        const watchFor = async marker => {
          let stdall = ``;
          let stdout = ``;

          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error(`Timeout reached without matching "${marker}"; server answered:\n\n${stdall}`));
            }, tests.TEST_TIMEOUT);

            const cleanup = () => {
              clearTimeout(timeout);

              child.stderr.off(`data`, onStderr);
              child.stdout.off(`data`, onStdout);
            };

            const onStderr = chunk => {
              stdall += chunk;
            };

            const onStdout = chunk => {
              stdall += chunk;
              stdout += chunk;
              if (stdout.includes(marker)) {
                cleanup();
                resolve(true);
              }
            };

            child.stderr.on(`data`, onStderr);
            child.stdout.on(`data`, onStdout);
          });
        };

        const runAndWait = async (marker, payload) => {
          const promise = expect(watchFor(marker)).resolves.toEqual(true);
          child.stdin.write(`${JSON.stringify(payload)}\n`);
          return await promise;
        };

        try {
          // We get the path to something that's definitely in a zip archive
          const lodashTypeDef = require.resolve(`@types/lodash/index.d.ts`)
            .replace(/\\/g, `/`)
            .replace(/^\/?/, `/`);
          const lodashTypeDir = lodashTypeDef.replace(/\/[^/]+$/, ``);

          // We'll also use this file (which we control, so its content won't
          // change) to get autocompletion infos. It depends on lodash too.
          const ourUtilityFile = require.resolve(`./editorSdks.utility.ts`)
            .replace(/\\/g, `/`)
            .replace(/^\/?/, `/`);

          // Same thing, but this file has virtual instances.
          const yarnpkgCli = npath.normalize(npath.join(__dirname, `../../../../yarnpkg-cli/sources/index.ts`))
            .replace(/\\/g, `/`);

          // Some sanity check to make sure everything is A-OK
          expect(lodashTypeDef).toContain(`.zip`);

          await runAndWait(`projectLoadingFinish`, {
            seq: 0,
            type: `request`,
            command: `open`,
            arguments: {file: ourUtilityFile},
          });

          await runAndWait(`zip:${lodashTypeDir}`, {
            seq: 1,
            type: `request`,
            command: `typeDefinition`,
            arguments: {file: ourUtilityFile, line: 5, offset: 9},
          });

          await runAndWait(yarnpkgCli, {
            seq: 2,
            type: `request`,
            command: `typeDefinition`,
            arguments: {file: ourUtilityFile, line: 4, offset: 9},
          });
        } finally {
          child.stdin.end();
        }
      },
    );
  });
});

const noPnpNode = async (args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: npath.fromPortablePath(cwd),
      stdio: [`ignore`, `pipe`, `inherit`],
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
      },
    });

    child.on(`error`, error => {
      reject(error);
    });

    const stdout = [];

    child.stdout.on(`data`, chunk => {
      stdout.push(chunk);
    });

    child.on(`close`, code => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString());
      } else {
        reject(new Error(`Process exited with status code ${code}`));
      }
    });
  });
};

const sdks = async (args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve(`@yarnpkg/monorepo/scripts/run-sdks.js`), ...args], {
      cwd: npath.fromPortablePath(cwd),
      stdio: `ignore`,
    });

    child.on(`error`, error => {
      reject(error);
    });

    child.on(`close`, code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with status code ${code}`));
      }
    });
  });
};
