# App Store Deployment Guide

This guide explains how to configure CI/CD for automatic deployment to app stores.

## Overview

The release workflow (`.github/workflows/release.yml`) builds and optionally uploads to:
- **Google Play Store** (Android)
- **Apple App Store** (iOS via TestFlight)
- **Microsoft Store** (Windows via MSIX)

Store uploads are **optional** - if secrets aren't configured, builds still go to GitHub Releases.

---

## Google Play Store

### Prerequisites
1. Create a [Google Play Developer account](https://play.google.com/console/) ($25 one-time)
2. Create your app in Play Console
3. Complete store listing, content rating, etc.

### Setup Steps

#### 1. Generate Upload Keystore

```bash
keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA \
  -keysize 2048 -validity 10000 -alias upload
```

Save this keystore securely - you'll need it forever!

#### 2. Create Service Account

1. Go to Play Console → Setup → API access
2. Create a new service account
3. Grant "Release manager" permissions
4. Download the JSON key file

#### 3. Configure GitHub Secrets

Go to repo Settings → Secrets and variables → Actions:

| Secret | Value |
|--------|-------|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i upload-keystore.jks` |
| `ANDROID_KEY_ALIAS` | `upload` (or your alias) |
| `ANDROID_KEY_PASSWORD` | Your key password |
| `ANDROID_STORE_PASSWORD` | Your store password |
| `PLAY_STORE_SERVICE_ACCOUNT_JSON` | Contents of service account JSON |

---

## Apple App Store

### Prerequisites
1. Enroll in [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. Create App ID in Developer Portal (com.zajel.zajel)
3. Create app in App Store Connect

### Setup Steps

#### 1. Create Distribution Certificate

1. Open Keychain Access on Mac
2. Certificate Assistant → Request a Certificate from a Certificate Authority
3. Go to Developer Portal → Certificates → Create Distribution Certificate
4. Download and install the certificate
5. Export as .p12 file

#### 2. Create Provisioning Profile

1. Go to Developer Portal → Profiles
2. Create "App Store" distribution profile
3. Select your App ID and certificate
4. Download the .mobileprovision file

#### 3. Create App Store Connect API Key

1. Go to App Store Connect → Users and Access → Keys
2. Generate a new key with "App Manager" role
3. Download the .p8 file (only downloadable once!)
4. Note the Key ID and Issuer ID

#### 4. Configure GitHub Secrets

| Secret | Value |
|--------|-------|
| `IOS_CERTIFICATE_BASE64` | `base64 -i Certificates.p12` |
| `IOS_CERTIFICATE_PASSWORD` | Your .p12 password |
| `IOS_PROVISIONING_PROFILE_BASE64` | `base64 -i profile.mobileprovision` |
| `APP_STORE_CONNECT_API_KEY_BASE64` | `base64 -i AuthKey_XXXXXX.p8` |
| `APP_STORE_CONNECT_KEY_ID` | Your Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | Your Issuer ID |

#### 5. Update ExportOptions.plist

Edit `ios/ExportOptions.plist` and replace the provisioning profile name with yours.

---

## Microsoft Store

### Prerequisites
1. Create a [Partner Center account](https://partner.microsoft.com/dashboard) ($19 one-time)
2. Reserve your app name

### Setup Steps

#### 1. Create Code Signing Certificate

For testing, create a self-signed certificate:

```powershell
New-SelfSignedCertificate -Type Custom -Subject "CN=Zajel" `
  -KeyUsage DigitalSignature -FriendlyName "Zajel Signing" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
```

For production, get a certificate from a trusted CA or use Partner Center's signing.

#### 2. Export Certificate

```powershell
$cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -eq "CN=Zajel" }
Export-PfxCertificate -Cert $cert -FilePath "zajel-signing.pfx" -Password (ConvertTo-SecureString -String "password" -Force -AsPlainText)
```

#### 3. Configure GitHub Secrets

| Secret | Value |
|--------|-------|
| `WINDOWS_CERTIFICATE_BASE64` | `[Convert]::ToBase64String([IO.File]::ReadAllBytes("zajel-signing.pfx"))` |
| `WINDOWS_CERTIFICATE_PASSWORD` | Your .pfx password |

---

## Local Development

### Android

Copy the example and fill in your values:

```bash
cp android/key.properties.example android/key.properties
# Edit android/key.properties with your keystore info
```

### iOS

Open in Xcode and configure signing:

```bash
open ios/Runner.xcworkspace
```

Select your team and provisioning profile in Signing & Capabilities.

---

## Troubleshooting

### Android: "Keystore was tampered with"
- Ensure base64 encoding doesn't add newlines: `base64 -w 0`

### iOS: "No signing certificate found"
- Certificate must match provisioning profile
- Check certificate hasn't expired

### Windows: "MSIX package is not signed"
- Certificate subject must match publisher in msix_config
- Self-signed certs only work if installed on target machine

---

## Release Process

1. Create and push a version tag:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. GitHub Actions builds all platforms
3. If secrets are configured:
   - Android AAB → Play Store (internal track, draft)
   - iOS IPA → TestFlight
   - Windows MSIX → included in GitHub Release

4. Review and promote in each store console
