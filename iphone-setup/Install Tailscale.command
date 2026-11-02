#!/bin/zsh
if [[ -f "$HOME/Downloads/Marshal-iPhone-Setup/Tailscale.pkg" ]]; then
  open "$HOME/Downloads/Marshal-iPhone-Setup/Tailscale.pkg"
else
  open 'https://tailscale.com/download/mac'
fi
