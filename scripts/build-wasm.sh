#!/usr/bin/env bash
# Build the browser engine and generate its JS glue into web/src/wasm/pkg.
set -euo pipefail
cd "$(dirname "$0")/.."
# Panic locations name files: no one's home directory in the download.
export RUSTFLAGS="--remap-path-prefix=$(rustc --print sysroot)/lib/rustlib/src/rust=rust --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}/registry/src=cargo"
cargo build -p tradoor-wasm --target wasm32-unknown-unknown --profile wasm
wasm-bindgen --target web --remove-producers-section --out-dir web/src/wasm/pkg target/wasm32-unknown-unknown/wasm/tradoor_wasm.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --converge --strip-target-features --strip-producers --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
    -o web/src/wasm/pkg/tradoor_wasm_bg.wasm web/src/wasm/pkg/tradoor_wasm_bg.wasm
fi
# wasm-bindgen names each import after a hash: some ninety names with sixteen random digits each,
# in the glue and again in the wasm, which hardly compress. Numbered in the glue's order instead,
# at the same length, both files are smaller and the same from one build to the next.
perl -e '
  local $/;
  my ($js, $wasm) = @ARGV;
  my $name = qr/(__wb[A-Za-z0-9_]*_)([0-9a-f]{16})(?![0-9A-Za-z_])/;
  my (%to, $n);
  open my $f, "<", $js or die "$js: $!"; my $glue = <$f>; close $f;
  $glue =~ s/$name/$to{"$1$2"} \/\/= $1 . sprintf("%016x", ++$n)/ge;
  open $f, "<:raw", $wasm or die "$wasm: $!"; my $bin = <$f>; close $f;
  $bin =~ s/$name/$to{"$1$2"} \/\/ die "an import the glue does not name: $1$2\n"/ge;
  open $f, ">", $js or die; print $f $glue; close $f;
  open $f, ">:raw", $wasm or die; print $f $bin; close $f;
' web/src/wasm/pkg/tradoor_wasm.js web/src/wasm/pkg/tradoor_wasm_bg.wasm
# Formulas, a module of their own loaded only when a chart has one: no glue, nothing imported.
cargo build -p tradoor-frost-script-wasm --target wasm32-unknown-unknown --profile wasm
mkdir -p web/src/wasm/frost-script
cp target/wasm32-unknown-unknown/wasm/tradoor_frost_script_wasm.wasm web/src/wasm/frost-script/frost-script.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --converge --strip-target-features --strip-producers --strip-debug --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
    -o web/src/wasm/frost-script/frost-script.wasm web/src/wasm/frost-script/frost-script.wasm
fi
for f in web/src/wasm/pkg/tradoor_wasm_bg.wasm web/src/wasm/pkg/tradoor_wasm.js web/src/wasm/frost-script/frost-script.wasm; do
  printf '%-45s %8d bytes  %7d gzip\n' "$f" "$(wc -c <"$f")" "$(gzip -9c "$f" | wc -c)"
done
