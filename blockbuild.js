const fs = require("fs");
const child_process = require("child_process");
const path = require("path");
const stream = require("stream");
const crypto = require("crypto");

const config = JSON.parse(fs.readFileSync("config.json"), "utf8");
const secretKey = process.env["GPG_SECRET_KEY"] ?? null;
const jobURL = process.env["GITHUB_JOB_URL"] ?? null;

const directives = {
  build: "[blockbuild:build]",
  force: "[blockbuild:force]",
  skip: "[blockbuild:skip]"
};

function handleDirectories() {
  if (!fs.existsSync("./out")) {
    console.log("Creating out directory...");
    fs.mkdirSync("./out");
  } else {
    console.log("Cleaning out directory...");
    fs.rmSync("./out", { recursive: true, force: true });
    fs.mkdirSync("./out");
  }

  if (!fs.existsSync("./out/mvn")) {
    console.log("Creating Maven directory...");
    fs.mkdirSync("./out/mvn");
  }

  if (!fs.existsSync("./tmp")) {
    console.log("Creating temporary directory...");
    fs.mkdirSync("./tmp");
  } else {
    console.log("Cleaning temporary directory...");
    fs.rmSync("./tmp", { recursive: true, force: true });
    fs.mkdirSync("./tmp");
  }

  if (!fs.existsSync("./tmp/gpg")) {
    console.log("Creating GPG directory...");
    fs.mkdirSync("./tmp/gpg");
  } else {
    console.log("Cleaning GPG directory...");
    fs.rmSync("./tmp/gpg", { recursive: true, force: true });
    fs.mkdirSync("./tmp/gpg");
  }
}

async function fetchPastArtifact(path) {
  const url = config.host + path;
  const req = await fetch(url);
  if (!req.ok) return null;
  return await req.text();
}

function exec(command, dir, _silent) {
  const silent = _silent ?? true;

  return new Promise((resolve, reject) => {
    const child = child_process.spawn(command, {
      cwd: dir ?? __dirname,
      shell: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      if (!silent) process.stdout.write(data);
      stdout += data;
    });

    child.stderr.on("data", (data) => {
      if (!silent) process.stderr.write(data);
      stderr += data;
    });

    child.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        statusCode: code
      });
    });
  });
}

function recursiveList(dir) {
  const files = fs.readdirSync(dir);
  const out = [];

  for (const file of files) {
    const fullPath = dir + "/" + file;
    if (fs.statSync(fullPath).isDirectory()) {
      out.push(...recursiveList(fullPath));
    } else {
      out.push(fullPath);
    }
  }

  return out;
}

async function main() {
  console.log("Setting up filesystem...");
  handleDirectories();

  console.log("Parsing commit directives...");
  const { stdout: commitDesc, statusCode: commitStatus } = await exec(
    "git log -1 --pretty=%B"
  );
  if (commitStatus !== 0) {
    console.log("Failed to get commit description!");
    process.exit(1);
  }

  const directiveLines = {};
  for (const [key, directive] of Object.entries(directives)) {
    // Try commit, then env variable
    const commitLine = commitDesc
      .split("\n")
      .find((line) => line.includes(directive));

    if (commitLine != null) {
      directiveLines[key] = commitLine;
    } else {
      directiveLines[key] =
        process.env[`BLOCKBUILD_DIRECTIVE_${key.toUpperCase()}`] ?? null;
    }
  }

  if (directiveLines.skip !== null) {
    console.log("Commit was set to skip all builds.");
    process.exit(0);
  }

  let forceBuilds = false;
  if (directiveLines.force !== null) {
    console.log("Commit was set to force all builds.");
    forceBuilds = true;
  }

  console.log("Fetching previous build information...");
  const previousHashes = await fetchPastArtifact("hashes.txt");
  const previousCommits = await fetchPastArtifact("commits.txt");

  const outURL = config.host + "out.tar.gz";
  const outReq = await fetch(outURL);
  if (outReq.ok) {
    console.log("Fetching previous build artifacts...");

    const outStream = fs.createWriteStream("./tmp/out.tar.gz");
    const readable = stream.Readable.from(outReq.body);
    readable.pipe(outStream);

    await new Promise((resolve) => outStream.on("finish", resolve));

    console.log("Extracting previous build artifacts...");
    const { statusCode: extractCode } = await exec(
      "tar -xz -C ./out -f ./tmp/out.tar.gz"
    );
    if (extractCode !== 0) {
      console.log("Failed to extract previous build artifacts!");
      process.exit(1);
    }
  } else {
    console.log("No previous build artifacts found.");
  }

  console.log("Removing previous build artifacts...");
  const toDelete = fs
    .readdirSync("./out")
    .filter(
      (file) =>
        file.startsWith("commits.txt") ||
        file.startsWith("hashes.txt") ||
        file.startsWith("info.txt")
    );
  toDelete.push("gpg");
  toDelete.push("out.tar.gz");

  for (const file of toDelete) {
    fs.rmSync(`./out/${file}`, { recursive: true, force: true });
  }

  const builds = config.builds.map((build) =>
    typeof build === "string" ? { name: build, project: "." } : build
  );

  for (const build of builds) {
    const { name, project } = build;

    const modDir = path.resolve(__dirname, `./mods/${name}`);
    const buildDir = path.resolve(__dirname, `${modDir}/build/libs`);
    const outDir = path.resolve(__dirname, `./out/${name}`);
    const mavenDir = path.resolve(__dirname, `./out/mvn`);

    const { stdout: commit, statusCode: commitStatus } = await exec(
      "git rev-parse HEAD",
      modDir
    );
    if (commitStatus !== 0) {
      console.log(`Failed to get commit hash for ${name}!`);
      continue;
    }

    const lastCommit = (previousCommits?.split("\n") ?? [])
      .map((line) => line.split(" "))
      .find((line) => line[1] === name)
      ?.shift();

    const shouldForceBuild =
      (directiveLines.build ?? "").includes(name) || forceBuilds;

    if (lastCommit === commit) {
      if (shouldForceBuild) {
        console.log(
          `${name}'s commit is unchanged, but force building anyways`
        );
      } else {
        console.log(`Skipping ${name} as commit hash is unchanged`);
        continue;
      }
    }

    console.log(`Building ${name}...`);
    if (fs.existsSync(buildDir)) {
      console.log("Cleaning build directory...");
      fs.rmSync(buildDir, { recursive: true, force: true });
    }

    const gradlew = path.resolve(modDir, "gradlew");
    if (!fs.existsSync(gradlew)) {
      console.log("Gradle not found!!!");
      process.exit(1);
    }

    // set execute on gradlew if not there
    if (!(fs.statSync(gradlew).mode & 1)) {
      console.log("Setting execute on gradlew...");
      fs.chmodSync(gradlew, 0o755);
    }

    // Sometimes I hate developing on Windows
    let gradleCommand = "gradlew";
    if (process.platform !== "win32") gradleCommand = `./${gradleCommand}`;
    const { statusCode: gradleStatus } = await exec(
      `${gradleCommand} build -p ${project}`,
      modDir,
      false
    );
    if (gradleStatus !== 0) {
      console.log(`Failed to build ${name}!`);
      process.exit(1);
    }

    console.log("Copying build artifacts...");
    fs.mkdirSync(outDir, { recursive: true });

    const buildFiles = fs.readdirSync(buildDir);
    for (const file of buildFiles) {
      fs.copyFileSync(path.resolve(buildDir, file), path.resolve(outDir, file));
    }

    console.log("Deploying to Maven...");
    const { stdout: gradleProperties } = await exec(
      `${gradleCommand} properties -q -p ${project}`,
      modDir
    );

    const { stdout: gradleTasks } = await exec(
      `${gradleCommand} tasks -q -p ${project}`,
      modDir
    );

    const hasMavenPublish = gradleTasks.includes("publishToMavenLocal");
    if (hasMavenPublish) {
      console.log("Using maven-publish...");
      const { statusCode: publishStatus } = await exec(
        `${gradleCommand} publishToMavenLocal -q -p ${project} -Dmaven.repo.local=${mavenDir}`,
        modDir
      );

      if (publishStatus !== 0) {
        console.log(`Failed to publish ${name} to Maven!`);
        process.exit(1);
      }
    } else {
      console.log("Using manual publish...");

      function findInGradleProperties(key) {
        const line = gradleProperties.find((line) => line.startsWith(key));
        if (line == null) return null;
        let value = line.split(":")[1].trim();

        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.substring(1, value.length - 1);
        }

        return value;
      }

      const group = findInGradleProperties("group");
      const artifact = findInGradleProperties("archivesBaseName");
      const version = findInGradleProperties("version");

      if (group == null || artifact == null || version == null) {
        console.log("Failed to find Maven information in gradle.properties!");
        console.log(`group=${group}, artifact=${artifact}, version=${version}`);
        process.exit(1);
      }

      for (const file of buildFiles) {
        const sourcesJar = file.replace(".jar", "-sources.jar");
        let sourcesArg = null;
        if (fs.existsSync(path.resolve(buildDir, sourcesJar))) {
          sources_arg = `-Dsources=${sourcesJar}`;
        }

        const command = [
          "mvn deploy:deploy-file",
          `-DgroupId=${group}`,
          `-DartifactId=${artifact}`,
          `-Dversion=${version}`,
          "-Dpackaging=jar",
          "-DrepositoryId=blockbuild",
          `-Dfile=${file}`,
          sourcesArg,
          `-Durl=file://${mavenDir}`
        ]
          .filter((arg) => arg != null)
          .join(" ");

        const { statusCode: deployStatus } = await exec(command, modDir, false);
        if (deployStatus !== 0) {
          console.log(`Failed to publish ${name} to Maven!`);
          process.exit(1);
        }
      }
    }
  }

  console.log("Generating hash file...");
  const hashes = recursiveList("./out").map((file) => {
    const buffer = fs.readFileSync(file);
    const hash = crypto.createHash("sha256");
    hash.update(buffer);

    return `${hash.digest("hex")} ${file}`;
  });
  fs.writeFileSync("./out/hashes.txt", hashes.join("\n"));

  console.log("Generating commit file...");
  let commits = "";
  for (const build of builds) {
    const { stdout: commit } = await exec(
      "git rev-parse HEAD",
      `./mods/${build.name}`
    );
    commits += `${commit} ${build.name}\n`;
  }

  fs.writeFileSync("./out/commits.txt", commits.trim());

  const { stdout: blockbuildCommit } = await exec("git rev-parse HEAD");

  let info = `
Build date: ${new Date().toISOString()}
Commit hash: ${blockbuildCommit}
CI log file: ${jobURL ?? "N/A"}

hashes.txt:
${hashes.join("\n")}

commits.txt:
${commits.trim()}
`;

  if (secretKey != null) {
    console.log("Signing hashes...");

    console.log("Importing secret key...");
    const decoded = Buffer.from(secretKey.trim(), "base64");
    fs.writeFileSync("./tmp/secret.key", decoded);
    const { statusCode: importStatus } = await exec(
      "gpg --import ./tmp/secret.key",
      null,
      false
    );
    if (importStatus !== 0) {
      console.log("Failed to import secret key!");
      process.exit(1);
    }

    console.log("Generating temporary key...");
    const gpgConfig = `
Key-Type: RSA
Key-Length: 4096
Name-Real: blockbuild
Name-Email: ${config.gpg.temp}
Expire-Date: 0
%no-protection
%commit
`.trim();
    fs.writeFileSync("./tmp/gpg.conf", gpgConfig);

    const { statusCode: genStatus } = await exec(
      "gpg --batch --gen-key --armor ./tmp/gpg.conf"
    );
    if (genStatus !== 0) {
      console.log("Failed to generate temporary key!");
      process.exit(1);
    }

    console.log("Exporting keys...");
    for (const [name, email] of Object.entries(config.gpg)) {
      const { statusCode: exportStatus } = await exec(
        `gpg --armor --export ${email} --output ./out/gpg/${name}.asc`
      );
      if (exportStatus !== 0) {
        console.log(`Failed to export key ${key}!`);
        process.exit(1);
      }
    }

    const { stdout: gpgKeys } = await exec("gpg --list-keys", null, false);
    info += `
GPG keys:
${gpgKeys.trim()}
`;
    fs.writeFileSync("./out/info.txt", info.trim());

    const files = fs
      .readdirSync("./out")
      .filter((file) => !fs.lstatSync(`./out/${file}`).isDirectory());

    for (const localFile of files) {
      const file = `./out/${localFile}`;
      console.log(`Signing ${file}...`);

      const { statusCode: mainSign } = await exec(
        `gpg --batch --output ${file}.sig --sign --default-key "${config.gpg.main}" ${file}`
      );
      if (mainSign !== 0) {
        console.log(`Failed to sign ${file} with main key!`);
        process.exit(1);
      }

      const { statusCode: tempSign } = await exec(
        `gpg --batch --output ${file}.tmp.sig --sign --default-key "${config.gpg.temp}" ${file}`
      );
      if (tempSign !== 0) {
        console.log(`Failed to sign ${file} with temp key!`);
        process.exit(1);
      }
    }
  }

  console.log("Compressing build artifacts...");
  // tar -czf ../tmp/out.tar.gz *
  const { statusCode: compressStatus } = await exec(
    "tar -czf ../tmp/out.tar.gz *",
    "./out"
  );

  if (compressStatus !== 0) {
    console.log("Failed to compress build artifacts!");
    process.exit(1);
  }

  fs.renameSync("./tmp/out.tar.gz", "./out/out.tar.gz");

  console.log("Done!");
  console.log(info);
}

main();
