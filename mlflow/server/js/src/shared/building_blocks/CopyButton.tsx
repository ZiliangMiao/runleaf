/**
 * Clipboard copying and button feedback.
 * Naming: copy* writes clipboard content; handle* responds to button events.
 * Sections: clipboard copying, copy button.
 */
import React, { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { Button, type ButtonProps, LegacyTooltip } from '@databricks/design-system';

// ===== Clipboard copying =====

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Browser permissions can reject the modern clipboard API.
    }
  }

  // Copying an empty selection leaves the existing clipboard unchanged.
  if (!text) {
    return false;
  }

  // Plain HTTP pages need a selection-based copy during the user's click.
  const activeElement = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  try {
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) {
      activeElement.focus({ preventScroll: true });
    }
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
}

// ===== Copy button =====

interface CopyButtonProps extends Partial<ButtonProps> {
  copyText: string;
  showLabel?: React.ReactNode;
  componentId?: string;
}

/** Copy the full text and show feedback after the clipboard operation finishes. */
export const CopyButton = ({ copyText, showLabel = true, componentId, ...buttonProps }: CopyButtonProps) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [copySucceeded, setCopySucceeded] = useState(false);

  const handleClick = async () => {
    setShowTooltip(false);
    setCopySucceeded(await copyToClipboard(copyText));
    setShowTooltip(true);
    setTimeout(() => {
      setShowTooltip(false);
    }, 3000);
  };

  const handleMouseLeave = () => {
    setShowTooltip(false);
  };

  return (
    <LegacyTooltip
      title={
        copySucceeded ? (
          <FormattedMessage defaultMessage="Copied" description="Tooltip text shown when copy operation completes" />
        ) : (
          <FormattedMessage defaultMessage="Copy failed" description="Tooltip text shown when copy operation fails" />
        )
      }
      dangerouslySetAntdProps={{
        visible: showTooltip,
      }}
    >
      <Button
        componentId={componentId ?? 'mlflow.shared.copy_button'}
        type="primary"
        onClick={handleClick}
        onMouseLeave={handleMouseLeave}
        css={{ 'z-index': 1 }}
        // Define children as a explicit prop so it can be easily overrideable
        children={
          showLabel ? <FormattedMessage defaultMessage="Copy" description="Button text for copy button" /> : undefined
        }
        {...buttonProps}
      />
    </LegacyTooltip>
  );
};
