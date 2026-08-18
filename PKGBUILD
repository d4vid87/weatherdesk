# Maintainer: David May <davidmay87@gmail.com>
pkgname=weatherdesk
pkgver=3.0.4
pkgrel=1
pkgdesc="Self-hosted dashboard for a WeatherFlow Tempest station"
arch=('x86_64' 'aarch64')
url="https://github.com/d4vid87/weatherdesk"
license=('MIT')
depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator')
makedepends=('cargo' 'pkgconf')
source=("$pkgname-$pkgver.tar.gz::$url/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('SKIP')

prepare() {
  cd "$pkgname-$pkgver/src-tauri"
  export RUSTUP_TOOLCHAIN=stable
  cargo fetch --locked
}

build() {
  cd "$pkgname-$pkgver/src-tauri"
  export RUSTUP_TOOLCHAIN=stable CARGO_TARGET_DIR=target
  cargo build --frozen --release --bin weatherdesk
}

check() {
  cd "$pkgname-$pkgver/src-tauri"
  export RUSTUP_TOOLCHAIN=stable
  cargo test --frozen --release --no-default-features
}

package() {
  cd "$pkgname-$pkgver"
  install -Dm755 "src-tauri/target/release/weatherdesk" "$pkgdir/usr/bin/weatherdesk"
  install -Dm644 "flatpak/io.github.davidmay87.weatherdesk.desktop" \
    "$pkgdir/usr/share/applications/io.github.davidmay87.weatherdesk.desktop"
  install -Dm644 "site/icon-512.png" \
    "$pkgdir/usr/share/icons/hicolor/512x512/apps/io.github.davidmay87.weatherdesk.png"
  install -Dm644 "site/icon-192.png" \
    "$pkgdir/usr/share/icons/hicolor/192x192/apps/io.github.davidmay87.weatherdesk.png"
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
