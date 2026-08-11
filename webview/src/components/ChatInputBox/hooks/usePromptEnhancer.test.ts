import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEnhancedPromptPayload, usePromptEnhancer } from './usePromptEnhancer';

describe('applyEnhancedPromptPayload', () => {
  it('keeps enhancing while streaming partial text', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: true, enhancedPrompt: 'partial text', done: false },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('partial text');
    expect(setIsEnhancing).not.toHaveBeenCalled();
  });

  it('stops enhancing when done is true', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: true, enhancedPrompt: 'final text', done: true },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('final text');
    expect(setIsEnhancing).toHaveBeenCalledWith(false);
  });

  it('treats missing done as finished for backward compatibility', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: true, enhancedPrompt: 'legacy final' },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('legacy final');
    expect(setIsEnhancing).toHaveBeenCalledWith(false);
  });

  it('shows error text when finished with failure', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: false, error: 'SDK missing', done: true },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('SDK missing');
    expect(setIsEnhancing).toHaveBeenCalledWith(false);
  });
});

describe('usePromptEnhancer', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('sends only prompt payload when requesting enhancement', () => {
    const editableRef = { current: document.createElement('div') };
    const setHasContent = vi.fn();
    const onInput = vi.fn();

    const { result } = renderHook(() => usePromptEnhancer({
      editableRef,
      getTextContent: () => 'Please refactor this module',
      setHasContent,
      onInput,
    }));

    act(() => {
      result.current.handleEnhancePrompt();
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'enhance_prompt:{"prompt":"Please refactor this module"}'
    );
  });

  it('streams partial text then finalizes on done', () => {
    const editableRef = { current: document.createElement('div') };

    const { result } = renderHook(() => usePromptEnhancer({
      editableRef,
      getTextContent: () => 'hello',
      setHasContent: vi.fn(),
    }));

    act(() => {
      result.current.handleEnhancePrompt();
    });
    expect(result.current.isEnhancing).toBe(true);

    act(() => {
      window.updateEnhancedPrompt?.(JSON.stringify({
        success: true,
        enhancedPrompt: 'Hel',
        done: false,
      }));
    });
    expect(result.current.enhancedPrompt).toBe('Hel');
    expect(result.current.isEnhancing).toBe(true);

    act(() => {
      window.updateEnhancedPrompt?.(JSON.stringify({
        success: true,
        enhancedPrompt: 'Hello world',
        done: true,
      }));
    });
    expect(result.current.enhancedPrompt).toBe('Hello world');
    expect(result.current.isEnhancing).toBe(false);
  });
});
