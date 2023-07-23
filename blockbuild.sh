#!/usr/bin/env bash
set -e

if [ ! -d "./out" ]; then
  echo "Creating out dir..."
  mkdir out
else
  echo "Cleaning out dir..."
  rm -rf ./out/*
fi

if [ ! -d "./out/mvn" ]; then
  echo "Creating Maven dir..."
  mkdir ./out/mvn
fi

hashes_txt_url=$(cat ./host_config.txt)"hashes.txt"
hashes_status_code=$(curl -s -o /dev/null -w "%{http_code}" $hashes_txt_url)

commits_txt_url=$(cat ./host_config.txt)"commits.txt"
commits_status_code=$(curl -s -o /dev/null -w "%{http_code}" $commits_txt_url)

out_url=$(cat ./host_config.txt)"out.tar.gz"
out_status_code=$(curl -s -o /dev/null -w "%{http_code}" $out_url)

previous_commits=""
previous_hashes=""

set +e
commit_description=$(git log -1 --pretty=%B)
build_line=$(echo "$commit_description" | grep "\[blockbuild:build\]")
force_build_line=$(echo "$commit_description" | grep "\[blockbuild:force\]")
skip_build_line=$(echo "$commit_description" | grep "\[blockbuild:skip\]")

if [ ! -z "$force_build_line" ]; then
  echo "Commit was set to force all builds."
  export BLOCKBUILD_FORCE_BUILD=1
fi

if [ ! -z "$skip_build_line" ]; then
  echo "Commit was set to skip all builds."
  exit 0
fi
set -e

if [ "$hashes_status_code" -eq 200 ] && [ "$commits_status_code" -eq 200 ]; then
  echo "Fetching previous build info..."
  previous_hashes=$(curl -s $hashes_txt_url)
  previous_commits=$(curl -s $commits_txt_url)
fi

echo "Extracting previous build artifacts..."
if [ "$out_status_code" -eq 200 ]; then
  curl -s $out_url | tar -xz -C ./out
else
  IFS=$'\n'
  for hash_line in $previous_hashes; do
    file=$(echo $hash_line | cut -d' ' -f3)
    # Remove up to the first slash
    file=${file#*/}

    outpath="./out/$file"

    echo "Downloading $file..."
    mkdir -p $(dirname $outpath)
    curl -s $(cat ./host_config.txt)$file -o $outpath
  done
  unset IFS
fi

rm -rf ./out/commits.txt* ./out/hashes.txt* ./out/info.txt* ./out/gpg ./out/out.tar.gz

function build() {
  project_name=$1
  project_arg=$2

  if [ -z "$project_arg" ]; then
    project_arg="."
  fi

  build_dir="$project_arg/build/libs"
  out_dir="../../out/$project_name"
  mvn_dir=$(pwd)/out/mvn

  if [ ! -z "$MSYSTEM" ]; then
    mvn_dir=$(pwd -W)/out/mvn
  fi

  cd ./mods/$project_name
  current_commit=$(git rev-parse HEAD)

  set +e
  in_build_line=$(echo "$build_line" | grep "$project_name")
  set -e

  if [[ "$previous_commits" == *"$current_commit $project_name"* ]] && [ -z "$BLOCKBUILD_FORCE_BUILD" ] && [ -z "$in_build_line" ]; then
    echo "Skipping $project_name as commit hash is unchanged"
    cd ../..
    return
  fi

  echo "Building $project_name..."
  if [ -d "$build_dir" ]; then
    echo "Cleaning build artifacts..."
    rm -rf $build_dir
  fi

  chmod +x ./gradlew
  ./gradlew build -p $project_arg

  echo "Copying build artifacts..."
  mkdir -p $out_dir
  cp $build_dir/*.jar $out_dir

  echo "Deploying to Maven..."
  gradle_properties=$(./gradlew properties -q -p $project_arg)
  gradle_tasks=$(./gradlew tasks -q -p $project_arg)
  has_maven_publish=$(echo "$gradle_tasks" | grep "publishToMavenLocal")

  # Use maven-publish when it's available, as our code is JANK
  if [ ! -z "$has_maven_publish" ]; then
    echo "Using maven-publish..."
    ./gradlew publishToMavenLocal -q -p $project_arg -Dmaven.repo.local=$mvn_dir
    cd ../..
    return
  fi

  for file in $build_dir/*.jar; do
    filename=$(basename $file)
    if [[ "$filename" == *"-sources.jar" ]]; then
      continue
    fi

    sources_file=$(echo $file | sed "s/.jar/-sources.jar/")
    sources_arg=""
    if [ -f "$sources_file" ]; then
      sources_arg="-Dsources=$sources_file"
    fi

    mvn deploy:deploy-file \
    -DgroupId=$(echo "$gradle_properties" | grep "^group:" | cut -d' ' -f2) \
    -DartifactId=$(echo "$gradle_properties" | grep "^archivesBaseName:" | cut -d' ' -f2) \
    -Dversion=$(echo "$gradle_properties" | grep "^version:" | cut -d' ' -f2) \
    -Dpackaging=jar \
    -DrepositoryId=blockbuild \
    -Dfile=$file \
    $sources_arg \
    -Durl=file://$mvn_dir
  done

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

echo "Generating hash file..."
# Append to a temporary file and then move it, so it doesn't appear in the hash list itself
cd ./out
find . -type f -exec sha256sum {} \; > /tmp/hashes.txt
mv /tmp/hashes.txt ./hashes.txt
cd ..

echo "Generating commit file..."
for dir in ./mods/*; do
  if [ ! -d "$dir" ]; then
    continue
  fi

  cd $dir
  echo "$(git rev-parse HEAD) $(basename $dir)" >> ../../out/commits.txt
  cd ../..
done

# cat EOF to ./out/info.txt
echo "Generating info file..."
cat << EOF > ./out/info.txt
Build date: $(date)
Commit hash: $(git rev-parse HEAD)
CI log file: $GITHUB_JOB_URL

hashes.txt:
$(cat ./out/hashes.txt)

commits.txt:
$(cat ./out/commits.txt)
EOF

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

  echo "Exporting keys..."
  mkdir -p ./out/gpg
  for key in $(gpg --list-keys --with-colons | grep "^pub" | cut -d: -f5); do
    gpg --armor --export $key > ./out/gpg/$key.asc
  done

  printf "\nGPG keys:\n" >> ./out/info.txt
  gpg --list-keys >> ./out/info.txt

  for file in ./out/*; do
    if [ ! -f "$file" ]; then
      continue
    fi

    if [[ "$file" == *".sig" ]]; then
      continue
    fi

    echo "Signing $file..."
    gpg --output $file.sig --sign --default-key "$GPG_SECRET_EMAIL" $file
    gpg --output $file.tmp.sig --sign --default-key "$GPG_TEMP_EMAIL" $file
  done
fi

echo "Compressing build artifacts..."
cd ./out
tar -czf /tmp/out.tar.gz *
mv /tmp/out.tar.gz ./out.tar.gz

cat ./info.txt
