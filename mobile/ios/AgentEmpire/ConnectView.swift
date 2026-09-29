import SwiftUI
import UIKit

/// Shared chrome for the two native screens: brand mark, title and a centred card that scrolls in landscape.
struct BrandedForm<Content: View>: View {
    let subtitle: String
    @ViewBuilder var content: Content
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var brand: some View {
        VStack(spacing: 10) {
            Image("LaunchMark").resizable().scaledToFit().frame(width: 64, height: 70).accessibilityHidden(true)
            Text("AGENT EMPIRE")
                .font(.system(size: 24, weight: .semibold))
                .tracking(6)
                .foregroundStyle(Color.brandInk)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle)
                .font(.footnote.weight(.medium))
                .textCase(.uppercase)
                .tracking(1.5)
                .foregroundStyle(Color.brandMuted)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .padding(20)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.08)))
            .frame(maxWidth: 440)
    }

    var body: some View {
        ScrollView {
            Group {
                // Landscape phones are short: brand beside the form instead of above it.
                if verticalSizeClass == .compact {
                    HStack(alignment: .center, spacing: 40) {
                        brand.frame(maxWidth: 260)
                        card
                    }
                } else {
                    VStack(spacing: 22) { brand; card }
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 20)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

struct PrimaryButton: View {
    let title: String
    let busy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(Color.brandBackground) }
                Text(title).fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity, minHeight: 46)
        }
        .buttonStyle(.borderedProminent)
        .foregroundStyle(Color.brandBackground)
        .disabled(busy)
    }
}

struct ConnectView: View {
    @EnvironmentObject private var model: AppModel
    @State private var address = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        BrandedForm(subtitle: "Connect to your Empire") {
            if let notice = model.notice {
                Label(notice, systemImage: "info.circle")
                    .font(.callout)
                    .foregroundStyle(Color.brandInk)
                    .accessibilityIdentifier("connect.notice")
            }
            Text("Server address").font(.subheadline.weight(.semibold)).foregroundStyle(Color.brandInk)
            TextField("https://city.example.com", text: $address)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.continue)
                .focused($focused)
                .onSubmit(connect)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.35)))
                .accessibilityIdentifier("connect.address")
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(Color.brandWarn)
                    .accessibilityIdentifier("connect.error")
            }
            PrimaryButton(title: busy ? "Checking…" : "Continue", busy: busy, action: connect)
                .accessibilityIdentifier("connect.continue")
            Text(footnote).font(.footnote).foregroundStyle(Color.brandMuted)
        }
        .onAppear { if address.isEmpty { address = model.lastHost } }
    }

    private var footnote: String {
        var text = "Use the HTTPS address of the Agent Empire server you run. Only connect to a server you trust."
        if HostPolicy.allowsLoopbackHTTP { text += " Debug build: http://localhost and http://127.0.0.1 are also allowed, for simulator testing." }
        return text
    }

    private func connect() {
        guard !busy else { return }
        switch HostPolicy.origin(from: address) {
        case .failure(let rejection):
            error = rejection.message
        case .success(let host):
            focused = false
            busy = true
            error = nil
            Task {
                do {
                    try await OfficeAPI.probe(host)
                    busy = false
                    model.connected(to: host)
                } catch {
                    busy = false
                    self.error = OfficeAPI.map(error).message
                }
            }
        }
    }
}

struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    let host: URL
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        BrandedForm(subtitle: "Sign in to your city") {
            VStack(alignment: .leading, spacing: 2) {
                Text("Server").font(.caption).foregroundStyle(Color.brandMuted)
                Text(host.host ?? HostPolicy.originString(host))
                    .font(.callout.monospaced())
                    .foregroundStyle(Color.brandInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("signin.host")
            }
            Text("Office password").font(.subheadline.weight(.semibold)).foregroundStyle(Color.brandInk)
            SecureField("Password", text: $password)
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(signIn)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.35)))
                .accessibilityIdentifier("signin.password")
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(Color.brandWarn)
                    .accessibilityIdentifier("signin.error")
            }
            PrimaryButton(title: busy ? "Signing in…" : "Sign in", busy: busy, action: signIn)
                .accessibilityIdentifier("signin.submit")
            Text("This device will appear as “\(UIDevice.current.name)” in your Empire's device list, where you can sign it out at any time.")
                .font(.footnote)
                .foregroundStyle(Color.brandMuted)
            Button("Use a different server") { model.changeServer() }
                .font(.callout)
                .disabled(busy)
                .accessibilityIdentifier("signin.change")
        }
        .onAppear { focused = true }
    }

    private func signIn() {
        guard !busy else { return }
        guard !password.isEmpty else { error = "Enter the office password."; return }
        focused = false
        busy = true
        error = nil
        let secret = password
        Task {
            do {
                let session = try await OfficeAPI.signIn(host: host, password: secret, deviceName: UIDevice.current.name)
                password = ""
                busy = false
                do {
                    try model.signedIn(session)
                } catch {
                    self.error = "Signed in, but this device couldn't store the sign-in securely. Try again."
                }
            } catch {
                busy = false
                self.error = OfficeAPI.map(error).message
            }
        }
    }
}
