/** Shared provider-neutral footer used by entry-auth cards. */

import { ExternalLink } from "@/components/marshal-ui/external-link";

import { SERVICE_TERMS_URL } from "./legal-links";

export function TermsFooter() {
  return (
    <p className="w-[224px] text-center text-sm leading-[1.4] text-foreground">
      By signing in, you agree to the{" "}
      <ExternalLink href={SERVICE_TERMS_URL} className="text-sm font-normal underline">
        Terms of Service
      </ExternalLink>
      .
    </p>
  );
}
