import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import BottomToolbar from '@/app/components/BottomToolbar';
import { SessionStatus } from '@/app/types';
import { uiText } from '@/app/i18n';

describe('BottomToolbar バージイン無効化トグル', () => {
  const baseProps = {
    sessionStatus: 'CONNECTED' as SessionStatus,
    onToggleConnection: vi.fn(),
    isPTTActive: false,
    setIsPTTActive: vi.fn(),
    isPTTUserSpeaking: false,
    handleTalkButtonDown: vi.fn(),
    handleTalkButtonUp: vi.fn(),
    isEventsPaneExpanded: true,
    setIsEventsPaneExpanded: vi.fn(),
    isAudioPlaybackEnabled: true,
    setIsAudioPlaybackEnabled: vi.fn(),
    isTextOutputEnabled: true,
    onTextOutputToggle: vi.fn(),
    codec: 'opus',
    onCodecChange: vi.fn(),
  };

  it('ラベル付きで表示される', () => {
    render(
      <BottomToolbar
        {...baseProps}
        isBargeInDisabled={false}
        setIsBargeInDisabled={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(uiText.toolbar.bargeInDisableLabel)).toBeDefined();
  });

  it('未接続時はトグルが無効化される', () => {
    render(
      <BottomToolbar
        {...baseProps}
        isBargeInDisabled={false}
        setIsBargeInDisabled={vi.fn()}
      />,
    );

    const toggle = screen.getByLabelText(uiText.toolbar.bargeInDisableLabel) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
  });

  it('トグル変更でハンドラが呼ばれる', () => {
    const handler = vi.fn();
    render(
      <BottomToolbar
        {...baseProps}
        isBargeInDisabled={false}
        setIsBargeInDisabled={handler}
      />,
    );

    fireEvent.click(screen.getByLabelText(uiText.toolbar.bargeInDisableLabel));
    expect(handler).toHaveBeenCalledWith(true);
  });
});
