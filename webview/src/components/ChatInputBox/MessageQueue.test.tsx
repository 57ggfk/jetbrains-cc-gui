import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { MessageQueue } from './MessageQueue';
import type { QueuedMessage } from '../../hooks/useMessageQueue';
import type { Attachment } from './types';

const t = ((key: string, options?: Record<string, unknown>) =>
  typeof options?.position === 'number' ? `${key}:${options.position}` : key) as unknown as TFunction;

const attachment: Attachment = { id: 'att-1', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' };

const createQueue = (): QueuedMessage[] => [
  { id: 'q-1', content: 'first message', queuedAt: 1 },
  { id: 'q-2', content: 'second message', attachments: [attachment], queuedAt: 2 },
];

describe('MessageQueue', () => {
  it('renders an edit button for every queued message and reports the edited id', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<MessageQueue queue={createQueue()} onRemove={onRemove} onEdit={onEdit} t={t} />);

    // Rows render in reverse queue order, so the first button belongs to q-2 —
    // the message closest to the input (the acceptance-scenario "second" item).
    const editButtons = screen.getAllByTitle('chat.queue.edit');
    expect(editButtons).toHaveLength(2);

    fireEvent.click(editButtons[0]);

    expect(onEdit).toHaveBeenCalledExactlyOnceWith('q-2');
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('keeps the remove button wired to its own callback', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<MessageQueue queue={createQueue()} onRemove={onRemove} onEdit={onEdit} t={t} />);

    fireEvent.click(screen.getAllByTitle('chat.queue.remove')[1]);

    expect(onRemove).toHaveBeenCalledExactlyOnceWith('q-1');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('shows nothing while the queue is empty', () => {
    const { container } = render(<MessageQueue queue={[]} onRemove={vi.fn()} onEdit={vi.fn()} t={t} />);

    expect(container.querySelector('.message-queue')).toBeNull();
  });
});
