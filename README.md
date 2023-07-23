# blockbuild

- Problem #1: Minecraft updates a lot. This means mods go out of date, and this means to get mods working closer to release days I usually have to build them from source.
- Problem #2: I have a [Packwiz](https://github.com/packwiz/packwiz) instance for all my mods, one instance for my client and multiple instances for my server. When having to build from source, it means I have to insert the .jar files into the Packwiz instance. Bundling them is not a good idea, because it's impossible to verify where they came from.
- Problem #3: You can't link a Packwiz mod file to a GitHub Actions artifact, because those artifacts require a GitHub account to download. While you can use a third party service like [nightly.link](https://nightly.link/) to access them, I don't want to depend on them.

The solution to all of these problems: blockbuild! blockbuild is a simple Node.js script and GitHub Actions workflow that builds and publishes mods to GitHub Pages, so I don't have to think about it, and users of my Packwiz instances can verify where they came from.

## Usage

- Fork this repository or copy the required files into your own repository.
  - `blockbuild.sh`, `.github/workflows/build.yml`, and `.gitignore`.
- Add submodules of your desired mods into the `mods` folder.
  - New to submodules? It's simple: `git submodule add <url>`
- Create your `config.json` - see the [section on it](#config).
- Push your repository, and enable GitHub Actions and GitHub Pages.
  - Workflows must have write permissions.
  - Pages must be deployed through GitHub Actions.

You can then access `hashes.txt` and `commits.txt` (along with `*.txt.sig` and `*.txt.tmp.sig`), which will provide a listing of all files and commits built by blockbuild.

When committing to this repository, you can add some directives into your commit message:

- `[blockbuild:skip]` will skip CI for this commit
- `[blockbuild:build] mod_name` will force that mod to build, even if there are no updates
- `[blockbuild:force]` will force all mods to build

## Config

The config has the following entries:

- `host`: The URL to your GitHub Pages deployment, with a trailing slash (`https://notnite.github.io/blockbuild/`).
- `gpg`: Configuration for [signing](#signing) - null if you choose to not sign, or an object with two entries.
  - `main`: the email used by the key you created for blockbuild
  - `temp`: the email that will be used for the temporary key
- `builds`: an array of build configurations
  - Either a string (the name in the `mods` folder), or an object with `name` and `project` (for mods that have separate projects, like Fabric and Forge support)

## Signing

blockbuild has an optional rudimentary system to export hash lists and sign that hash list with GPG keys. It both uses a pre-existing key (to show you control the workflow) and generates one on the fly (to verify the artifacts came from the workflow).

To use it, you will need to generate a key. You can generate them with `gpg --full-generate-key`, then export it with `gpg --list-secret-keys <name>` and `gpg --export-secret-keys <id> | base64`. Put the Base64 encoded key as a secret named `GPG_SECRET_KEY`.

## Maven

blockbuild automatically generates a Maven repository for the output artifacts under the `mvn` folder. It uses `maven-publish` when possible, falling back to publishing it manually with `mvn`. Simply add `/mvn/` to the end of your blockbuild host (`https://notnite.github.io/blockbuild/mvn/`).

## Packwiz

A `generate-packwiz.js` script is provided for generating `.pw.toml` files automatically:

```shell
$ node generate-packwiz.js Squake/squake-2.0.0.jar
name = "squake-2.0.0"
filename = "squake-2.0.0.jar"
side = "both"

[download]
url = "https://notnite.github.io/blockbuild/Squake/squake-2.0.0.jar"
hash-format = "sha256"
hash = "0d59872f37b7c0059caf686ea6de5f68621b3fe4fa8160f398de63fff838901d"
```

You are expected to edit the name and side yourself.
