/**
 * Design-system component tests: semantic badges, confirm dialog behaviour,
 * modal accessibility (Escape + focus), and pagination state.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Badge,
  ConfirmDialog,
  Modal,
  Pagination,
} from './ui';
import { incidentStatus, processingStatus, rootCauseStatus } from '../lib/labels';

describe('semantic status badges', () => {
  it('communicates incident status with icon and text, not colour alone', () => {
    render(<Badge presentation={incidentStatus('investigating')} />);
    const badge = screen.getByText('Investigating').closest('.badge');
    expect(badge).toBeInTheDocument();
    // Icon (aria-hidden) and label text both present.
    expect(badge?.querySelector('.badge__icon')).toBeInTheDocument();
    expect(badge).toHaveAttribute('class', expect.stringContaining('badge--info'));
  });

  it('renders every incident status without crashing', () => {
    for (const status of [
      'open', 'investigating', 'waiting_for_information', 'waiting_for_parts',
      'resolved', 'closed', 'reopened', 'cancelled',
    ]) {
      const { unmount } = render(<Badge presentation={incidentStatus(status)} />);
      expect(screen.getByText(incidentStatus(status).label)).toBeInTheDocument();
      unmount();
    }
  });

  it('distinguishes root-cause confirmed/suspected/rejected by tone and label', () => {
    render(
      <div>
        <Badge presentation={rootCauseStatus('confirmed')} />
        <Badge presentation={rootCauseStatus('suspected')} />
        <Badge presentation={rootCauseStatus('rejected')} />
      </div>,
    );
    expect(screen.getByText('Confirmed').closest('.badge')).toHaveClass('badge--ok');
    expect(screen.getByText('Suspected').closest('.badge')).toHaveClass('badge--warn');
    expect(screen.getByText('Rejected').closest('.badge')).toHaveClass('badge--error');
  });

  it('marks completed manuals as searchable and failures as error', () => {
    render(
      <div>
        <Badge presentation={processingStatus('completed')} />
        <Badge presentation={processingStatus('embedding_failed')} />
      </div>,
    );
    expect(screen.getByText(/completed/i).closest('.badge')).toHaveClass('badge--ok');
    expect(screen.getByText(/embedding failed/i).closest('.badge')).toHaveClass('badge--error');
  });
});

describe('ConfirmDialog', () => {
  it('requires a note before enabling the destructive confirm', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={onConfirm}
        title="Close incident?"
        confirmLabel="Close incident"
        requireNote
        noteLabel="Resolution summary"
      >
        <p>Requires a resolution summary.</p>
      </ConfirmDialog>,
    );

    const confirm = screen.getByRole('button', { name: 'Close incident' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/resolution summary/i), 'Replaced the seal.');
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Replaced the seal.');
  });

  it('warns when an action is irreversible', () => {
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={() => undefined}
        title="Delete?"
        irreversible
      >
        <p>Body</p>
      </ConfirmDialog>,
    );
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });
});

describe('Modal', () => {
  it('is labelled and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Rename conversation">
        <input aria-label="Title" />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Pagination', () => {
  it('disables prev on first page and next on last page', () => {
    const onPage = vi.fn();
    const { rerender } = render(
      <Pagination page={1} totalPages={3} total={45} onPage={onPage} />,
    );
    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next page/i })).toBeEnabled();
    expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();

    rerender(<Pagination page={3} totalPages={3} total={45} onPage={onPage} />);
    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
  });

  it('renders nothing when there are no records', () => {
    const { container } = render(
      <Pagination page={1} totalPages={0} total={0} onPage={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
