import { useEffect, useState, useMemo } from "react";
import type { MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { Nav } from "~/components/Nav";
import { Footer } from "~/components/Footer";

export const meta: MetaFunction = () => {
  return [
    { title: "Zajel - Private P2P Messaging" },
    {
      name: "description",
      content:
        "End-to-end encrypted peer-to-peer messaging. No servers, no tracking, no compromise on privacy.",
    },
    { property: "og:title", content: "Zajel - Private P2P Messaging" },
    {
      property: "og:description",
      content: "End-to-end encrypted peer-to-peer messaging. No servers, no tracking.",
    },
    { property: "og:type", content: "website" },
    { property: "og:url", content: "https://zajel.app/" },
    { property: "og:image", content: "https://zajel.app/og-image.png" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: "Zajel - Private P2P Messaging" },
    {
      name: "twitter:description",
      content: "End-to-end encrypted peer-to-peer messaging. No servers, no tracking.",
    },
    { name: "twitter:image", content: "https://zajel.app/og-image.png" },
  ];
};

const GITHUB_REPO = "Hamza-Labs-Core/zajel";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

interface Platform {
  name: string;
  icon: string;
  extension: string;
}

const platforms: Record<string, Platform> = {
  android: { name: "Android", icon: "📱", extension: "apk" },
  ios: { name: "iOS", icon: "🍎", extension: "ipa" },
  windows: { name: "Windows", icon: "🪟", extension: "zip" },
  macos: { name: "macOS", icon: "💻", extension: "dmg" },
  linux: { name: "Linux", icon: "🐧", extension: "tar.gz" },
};

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

function detectPlatform(): string | null {
  if (typeof navigator === "undefined") return null;
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();

  if (/android/.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/.test(userAgent)) return "ios";
  if (/win/.test(platform)) return "windows";
  if (/mac/.test(platform)) return "macos";
  if (/linux/.test(platform)) return "linux";

  return null;
}

function isValidGithubDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'github.com' ||
       parsed.hostname.endsWith('.githubusercontent.com'))
    );
  } catch {
    return false;
  }
}

function findAssetUrl(assets: ReleaseAsset[], platform: string): string | null {
  const ext = platforms[platform].extension;
  const asset = assets.find((a) => {
    const name = a.name.toLowerCase();
    return name.includes(platform) && (name.endsWith(`.${ext}`) || name.endsWith(".zip"));
  });
  if (asset && isValidGithubDownloadUrl(asset.browser_download_url)) {
    return asset.browser_download_url;
  }
  return null;
}

export async function clientLoader() {
  try {
    const res = await fetch(GITHUB_API, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Zajel-Website',
      },
    });
    if (!res.ok) {
      return { release: null };
    }
    const data = await res.json();
    if (!data.tag_name || !Array.isArray(data.assets)) {
      return { release: null };
    }
    return { release: data as Release };
  } catch {
    return { release: null };
  }
}

export default function Home() {
  const { release } = useLoaderData<typeof clientLoader>();
  const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null);

  const downloadUrls = useMemo(() => {
    const urls: Record<string, string | null> = {};
    if (release?.assets) {
      Object.keys(platforms).forEach((p) => {
        urls[p] = findAssetUrl(release.assets, p);
      });
    }
    return urls;
  }, [release]);

  useEffect(() => {
    setDetectedPlatform(detectPlatform());
  }, []);

  return (
    <>
      <Nav />

      {/* Hero Section */}
      <section className="hero">
        <h1>Private P2P Messaging</h1>
        <p className="hero-tagline">
          End-to-end encrypted communication that stays between you and your contacts. No servers
          storing your messages. No tracking. No compromise.
        </p>
        <div className="hero-buttons">
          <a href="#download" className="btn btn-primary">
            <span>Download</span>
            {release?.tag_name && <span>{release.tag_name}</span>}
          </a>
          <Link to="/guide" className="btn btn-secondary">
            View Guide
          </Link>
        </div>
      </section>

      {/* Features Section */}
      <section className="features" id="features">
        <h2 className="section-title">Why Zajel?</h2>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">🔒</div>
            <h3>End-to-End Encrypted</h3>
            <p>
              Messages are encrypted using X25519 key exchange and ChaCha20-Poly1305. Only you and
              your recipient can read them.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🌐</div>
            <h3>Peer-to-Peer</h3>
            <p>
              Messages travel directly between devices. No central server stores or has access to
              your conversations.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📡</div>
            <h3>Local Discovery</h3>
            <p>
              Automatically find devices on your local network using mDNS. No internet required for
              local messaging.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📱</div>
            <h3>Cross-Platform</h3>
            <p>
              Available for Android, iOS, Windows, macOS, and Linux. Message anyone regardless of
              their device.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📁</div>
            <h3>File Sharing</h3>
            <p>
              Send files of any type securely. All transfers are encrypted end-to-end just like
              messages.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">👤</div>
            <h3>No Account Required</h3>
            <p>
              Start messaging immediately. No email, phone number, or personal information needed.
            </p>
          </div>
        </div>
      </section>

      {/* Downloads Section */}
      <section className="downloads" id="download">
        <div className="downloads-container">
          <h2 className="section-title">Download Zajel</h2>
          <div className="download-grid">
            {Object.entries(platforms).map(([key, platform]) => {
              const url = downloadUrls[key];
              const isRecommended = key === detectedPlatform;
              const isDisabled = !url;

              return (
                <a
                  key={key}
                  href={url || "#"}
                  className={`download-card ${isDisabled ? "disabled" : ""} ${
                    isRecommended && !isDisabled ? "recommended" : ""
                  }`}
                  onClick={(e) => isDisabled && e.preventDefault()}
                  target={url ? "_blank" : undefined}
                  rel={url ? "noopener noreferrer" : undefined}
                >
                  {isRecommended && !isDisabled && (
                    <div className="recommended-badge">Recommended</div>
                  )}
                  <div className="download-icon">{platform.icon}</div>
                  <h4>{platform.name}</h4>
                  <span>{url ? platform.extension.toUpperCase() : "Coming Soon"}</span>
                </a>
              );
            })}
          </div>
          <div className="download-github">
            <a
              href={`https://github.com/${GITHUB_REPO}/releases/latest`}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              View All Releases on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Store Section */}
      <section className="stores" id="stores">
        <div className="stores-container">
          <h2 className="section-title">Coming to App Stores</h2>
          <p style={{ color: "var(--text-muted)", marginBottom: "1rem" }}>
            Zajel will be available on major app stores soon.
          </p>
          <div className="store-badges">
            <div className="store-badge">
              <span className="badge-icon">▶️</span>
              <span>Google Play - Coming Soon</span>
            </div>
            <div className="store-badge">
              <span className="badge-icon">🍎</span>
              <span>App Store - Coming Soon</span>
            </div>
            <div className="store-badge">
              <span className="badge-icon">🪟</span>
              <span>Microsoft Store - Coming Soon</span>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
