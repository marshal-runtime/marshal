#!/bin/zsh
for binary in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if [[ -x "$binary" ]]; then
    "$binary" serve --bg 7331
    print '\nReturn to Marshal Settings → iPhone access → Connect with Tailscale.'
    read '?Press Enter to close.'
    exit
  fi
done
open 'https://tailscale.com/download/mac'
print 'Install Tailscale, open it, and sign in. Then run this file again.'
read '?Press Enter to close.'
