#!/usr/bin/env bash
set -e

if [ ! -d "./out" ]; then
  echo "Creating out dir..."
  mkdir out
else
  echo "Cleaning out dir..."
  rm -rf ./out/*
fi

function build() {
  project_name=$1
  project_arg=$2

  if [ -z "$project_arg" ]; then
    project_arg="."
  fi

  build_dir="$project_arg/build/libs"
  out_dir="../../out/$project_name"

  echo "Building $project_name..."

  cd ./libs/$project_name
  if [ -d "$build_dir" ]; then
    echo "Cleaning build artifacts..."
    rm -rf $build_dir
  fi

  ./gradlew build -p $project_arg

  echo "Copying build artifacts..."
  mkdir -p $out_dir
  cp $build_dir/*.jar $out_dir

  cd ../..
}

# read was doing some weird stuff so this'll work
build_config=`cat ./build_config.txt`
line_count=`echo "$build_config" | wc -l`
for (( i=1; i<=$line_count; i++ )); do
  line=`echo "$build_config" | sed -n "$i"p`
  if [ -z "$line" ]; then
    continue
  fi
  build $line
done

echo "Generating hashes..."
find ./out -type f -exec sha256sum {} \; > ./out/hashes.txt

if [ ! -z "$GPG_SECRET_KEY" ]; then
  echo "Signing hashes..."

  if [ ! -d "./gpg" ]; then
    echo "Creating GPG dir..."
    mkdir ./gpg
  else
    echo "Cleaning GPG dir..."
    rm -rf ./gpg/*
  fi

  export GNUPGHOME=`pwd`/gpg

  echo "Importing secret key..."
  echo "$GPG_SECRET_KEY" | base64 -d | gpg --import

  echo "Generating temporary key..."
  gpg_config="Key-Type: RSA
Key-Length: 4096
Name-Real: blockbuild
Name-Email: $GPG_TEMP_EMAIL
Expire-Date: 0
%no-protection
%commit"
  echo "$gpg_config" | gpg --batch --gen-key --armor

  gpg --list-keys

  gpg --output ./out/hashes.txt.sig --sign --default-key "$GPG_SECRET_EMAIL" ./out/hashes.txt
  gpg --output ./out/hashes.txt.sig.tmp --sign --default-key "$GPG_TEMP_EMAIL" ./out/hashes.txt
fi
