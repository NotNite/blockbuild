# blockbuild

- Problem #1: Minecraft updates a lot. This means mods go out of date, and this means to get mods working closer to release days I usually have to build them from source.
- Problem #2: I have a [Packwiz](https://github.com/packwiz/packwiz) instance for all my mods, one instance for my client and multiple instances for my server. When having to build from source, it means I have to insert the .jar files into the Packwiz instance. Bundling them is not a good idea, because it's impossible to verify where they came from.
- Problem #3: You can't link a Packwiz mod file to a GitHub Actions artifact, because those artifacts require a GitHub account to download. While you can use a third party service like [nightly.link](https://nightly.link/) to access them, I don't want to depend on them.

The solution to all of these problems: blockbuild! blockbuild is a simple shell script and GitHub Actions workflow that builds and publishes mods to GitHub Pages, so I don't have to think about it, and users of my Packwiz instances can verify where they came from.

## Usage

- Fork this repository or copy the required files into your own repository.
  - `blockbuild.sh`, `.github/workflows/build.yml`, and `.gitignore`.
- Add submodules of your desired mods into the `libs` folder.
  - New to submodules? It's simple: `git submodule add <url>`
- Create a `build_config.txt`.
  - Each line contains the folder name in `libs`, and the directory the `build` folder is located in (optional; defaults to `.`).
- Push your repository, and enable GitHub Actions and GitHub Pages.

## Signing

blockbuild also has an optional rudimentary system to export hash lists and sign that hash list with GPG keys. It both uses a pre-existing key (to show you control the workflow) and generates one on the fly (to verify the artifacts came from the workflow).

To use it, set these secrets in the workflow:

- `GPG_SECRET_KEY`: a Base64 encoded GPG secret key.
  - Generate and export a new secret key with `gpg --full-generate-key`, `gpg --list-secret-keys <name>`, and `gpg --export-secret-keys <id> | base64`. Don't add a passphrase!
- `GPG_SECRET_EMAIL`: the email associated to the key in `GPG_SECRET_KEY`.
- `GPG_TEMP_EMAIL`: the email used by the temporary GPG key. Must not conflict with `GPG_SECRET_EMAIL`.
