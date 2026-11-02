# Marshal on your iPhone

The phone view is built into this checkout. It uses your Mac's existing chats and agent runtime. You do not need an Apple developer account or a public website.

## Tomorrow: first connection

1. **Install Tailscale on the Mac and iPhone**, then sign in to the same Tailscale account on both. On the Mac, double-click `Install Tailscale.command` in this folder. On the iPhone, install Tailscale from the App Store. Accept each device's normal VPN/network-extension prompt and switch Tailscale on.
2. **Restart Marshal to load the new build.** When your current work has finished, quit the running Marshal/Electron app, then double-click `Start Marshal.command` in this folder. This opens the already-built checkout with its existing development profile. Leave its Terminal window open. Do not open an older installed build instead.
3. In Marshal, open **Settings → iPhone access → Connect with Tailscale**. This discovers your Mac's private address, enables Serve, and starts remote access. If Tailscale asks to enable HTTPS, double-click `Enable Tailscale HTTPS.command`, follow the approval URL it displays, and click **Connect with Tailscale** again. Wait for **Ready**.
4. Click **Show access key**. **Scan the QR code with your iPhone camera** and open its link in Safari. You should see your Marshal conversations. Alternatively, open the displayed HTTPS address in Safari and enter the access key.
5. In Safari, choose **Share → Add to Home Screen**, keep **Open as Web App** enabled, name it Marshal, tap **Add**, and open its icon. If the home-screen app asks for the access key again, enter the same key; Safari and the installed view may have separate browser storage.
6. To check access away from home, turn off the phone's Wi-Fi, keep Tailscale connected, and open Marshal over cellular.

After setup, you normally just tap the Marshal icon. Keep Tailscale enabled on both devices and Marshal running on the Mac. Its main window can be closed. Remote access prevents idle system sleep while enabled; leave the Mac plugged in, and keep a laptop lid open unless you have a supported awake clamshell setup. Explicit sleep, shutdown, quitting Marshal, or loss of internet makes the Mac unavailable.

## What works

- Browse full-screen chats by project, search conversations, start a chat, read history and live responses.
- Tap a project heading to collapse/expand it; use its right-hand plus to start a chat in that project. Tap the star beside a conversation to pin/unpin it.
- New chats default to General. Use the project selector above the composer to choose a registered project before sending; changing projects preserves draft text and attachments. Once messages are sent, that conversation keeps its project.
- Open the Chats menu for Projects and This computer & app setup; the computer name appears at the top.
- Send, stop, choose a model, and steer by holding the Send button while a turn runs.
- Answer permission cards and questions, including with the Mac window closed.
- Attach images and files up to 10 MB. Files are uploaded to the Mac before sending.
- Reconnect after switching apps or losing network; text drafts are saved on this device.
- View supported local images from registered workspace roots and Marshal's image upload directory.

The editor and chat UI are shared with desktop Marshal. Desktop settings, native windows/file dialogs, screen capture, microphone transcription, extension panels, and arbitrary Mac filesystem browsing are not part of the phone surface. Image previews are restricted to registered workspace roots; SVG/HTML previews and arbitrary filesystem paths are deliberately not served.

## If something needs attention

| Symptom                               | Action                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No “iPhone access” setting            | Quit the old process and use `Start Marshal.command` from this folder.                                                                                                                                                                                                                     |
| No conversations / unexpected profile | This launcher uses the checkout's `.marshal-dev` profile (or your existing `MARSHAL_DEV_DATA_DIR` override), not a separate installed app's `.marshal` profile. Open the updated build with the same profile as the chats you expect. Do not copy live session databases between profiles. |
| Tailscale not found                   | Install the standalone Mac app and open/sign in to it. Then retry Connect with Tailscale.                                                                                                                                                                                                  |
| HTTPS approval needed                 | Run `Enable Tailscale HTTPS.command` and approve Tailscale's HTTPS link.                                                                                                                                                                                                                   |
| Tailscale already serves another app  | Automatic setup intentionally leaves that configuration intact. Configure a separate private Serve endpoint manually before changing Marshal's address.                                                                                                                                    |
| Mac disconnected                      | Check that Marshal and Tailscale are running. Tap Reconnect or reopen the home-screen app.                                                                                                                                                                                                 |
| Key reset while phone was open        | Reload the phone page and scan/enter the new key.                                                                                                                                                                                                                                          |
| Message send was interrupted          | Read the refreshed conversation before resending; Marshal does not automatically duplicate uncertain sends.                                                                                                                                                                                |
| Runtime asks for sign-in              | Complete provider sign-in on the Mac, then reconnect the phone.                                                                                                                                                                                                                            |

**Disable access** stops the server. **Reset key and disconnect all devices** invalidates previous browser credentials and closes connections. Treat the QR code and key as access to your Marshal.

## Preparation and testing

The application and phone assets are built in `dist-electron/` and `dist/`. Automated acceptance uses an isolated Marshal profile and the real HTTP/WebSocket bridge with Chromium and WebKit at phone sizes. It checks sending, multiple views, reconnect/drafts, and the live permission pipeline after the Mac window closes. Separate server tests cover authentication, origin checks, operation validation, upload handling, and media path confinement.

Tailscale account sign-in, macOS VPN approval, the final private-network connection, and a physical iPhone's keyboard/home-screen behavior require your devices. Those steps cannot be completed or truthfully claimed tested without your sign-in and phone.

Official references: [Tailscale Mac installation](https://tailscale.com/docs/install/mac), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [WebKit home-screen behavior](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).
