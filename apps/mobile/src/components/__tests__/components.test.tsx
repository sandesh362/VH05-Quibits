/**
 * Component tests: status badges, form controls, states and confirmation
 * dialogs. Rendered with @testing-library/react-native under jest-expo -
 * no device or Expo Go required.
 */
import { Text } from 'react-native';
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Badge, Button, Card, ChoiceGroup, StatTile, TextField, Chip } from '@/components/ui';
import { EmptyState, ErrorState, CachedNotice, InlineBanner, LoadingState } from '@/components/states';
import { OfflineBanner, PendingSyncBanner, ConfirmDialog } from '@/components/banners';

describe('Badge', () => {
  it('renders icon + label (never colour alone) and exposes an accessibility label', () => {
    const { getByText, getByLabelText } = render(<Badge icon="✓" label="Confirmed" tone="ok" />);
    expect(getByText('Confirmed')).toBeTruthy();
    expect(getByText('✓', { includeHiddenElements: true })).toBeTruthy();
    expect(getByLabelText('Confirmed')).toBeTruthy();
  });
});

describe('Button', () => {
  it('fires onPress and reports disabled state', () => {
    const onPress = jest.fn();
    const { getByRole } = render(<Button label="Save" onPress={onPress} />);
    fireEvent.press(getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire while disabled', () => {
    const onPress = jest.fn();
    const { getByRole } = render(<Button label="Save" onPress={onPress} disabled />);
    fireEvent.press(getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('shows a working indicator while loading', () => {
    const { getByText } = render(<Button label="Save" loading />);
    expect(getByText('Working…')).toBeTruthy();
  });
});

describe('ChoiceGroup', () => {
  const options = [
    { value: 'low', label: 'Low', icon: '▽', tone: 'neutral' as const },
    { value: 'critical', label: 'Critical', icon: '⯅', tone: 'error' as const },
  ];

  it('marks the selected option via accessibility state', () => {
    const { getByLabelText } = render(
      <ChoiceGroup label="Severity" options={options} value="critical" onChange={() => {}} />,
    );
    expect(getByLabelText('Severity: Critical')).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
    expect(getByLabelText('Severity: Low')).toHaveProp('accessibilityState', expect.objectContaining({ selected: false }));
  });

  it('reports the chosen value on press', () => {
    const onChange = jest.fn();
    const { getByLabelText } = render(
      <ChoiceGroup label="Severity" options={options} value="low" onChange={onChange} />,
    );
    fireEvent.press(getByLabelText('Severity: Critical'));
    expect(onChange).toHaveBeenCalledWith('critical');
  });

  it('renders a validation error', () => {
    const { getByText } = render(
      <ChoiceGroup label="Severity" options={options} value={undefined} onChange={() => {}} error="Pick one." />,
    );
    expect(getByText('Pick one.')).toBeTruthy();
  });
});

describe('TextField', () => {
  it('propagates text changes and shows field errors', () => {
    const onChange = jest.fn();
    const { getByLabelText, getByText } = render(
      <TextField label="Title" value="" onChangeText={onChange} error="Required" />,
    );
    fireEvent.changeText(getByLabelText('Title'), 'Pump down');
    expect(onChange).toHaveBeenCalledWith('Pump down');
    expect(getByText('Required')).toBeTruthy();
  });
});

describe('screen states', () => {
  it('EmptyState renders message + action', () => {
    const onAction = jest.fn();
    const { getByText, getByRole } = render(
      <EmptyState title="No incidents" message="Nothing yet." actionLabel="Create one" onAction={onAction} />,
    );
    expect(getByText('No incidents')).toBeTruthy();
    expect(getByText('Nothing yet.')).toBeTruthy();
    fireEvent.press(getByRole('button'));
    expect(onAction).toHaveBeenCalled();
  });

  it('ErrorState renders retry with a readable message and reference id', () => {
    const onRetry = jest.fn();
    const { getByText, getByRole } = render(
      <ErrorState message="Cannot reach the server." onRetry={onRetry} requestId="req_9" />,
    );
    expect(getByText('Cannot reach the server.')).toBeTruthy();
    expect(getByText('Reference: req_9')).toBeTruthy();
    fireEvent.press(getByRole('button'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('LoadingState and skeletons announce loading', () => {
    const { getByLabelText } = render(<LoadingState label="Loading incidents…" />);
    expect(getByLabelText('Loading incidents…')).toBeTruthy();
  });

  it('CachedNotice says the data may be out of date', () => {
    const { getByText, getByLabelText } = render(<CachedNotice age="2 min ago" />);
    expect(getByLabelText('Showing a saved copy')).toBeTruthy();
    expect(getByText(/may be out of date/)).toBeTruthy();
  });

  it('InlineBanner supports warning tone copy', () => {
    const { getByText } = render(<InlineBanner tone="warn">Offline — showing a saved copy.</InlineBanner>);
    expect(getByText(/Offline/)).toBeTruthy();
  });
});

describe('banners', () => {
  it('OfflineBanner is hidden when online', () => {
    const { queryByLabelText } = render(<OfflineBanner visible={false} />);
    expect(queryByLabelText('You are offline')).toBeNull();
  });

  it('OfflineBanner explains queued sync when offline', () => {
    const { getByText } = render(<OfflineBanner visible />);
    expect(getByText(/saved on this device and synced/)).toBeTruthy();
  });

  it('PendingSyncBanner distinguishes review-needed from plain pending', () => {
    const onPress = jest.fn();
    const { getByRole, getByText } = render(<PendingSyncBanner pending={2} review={1} onPress={onPress} />);
    expect(getByText(/need[s]? review/)).toBeTruthy();
    fireEvent.press(getByRole('button'));
    expect(onPress).toHaveBeenCalled();
  });

  it('PendingSyncBanner hides when idle', () => {
    const { queryByText } = render(<PendingSyncBanner pending={0} review={0} onPress={() => {}} />);
    expect(queryByText(/waiting to sync/)).toBeNull();
  });
});

describe('ConfirmDialog', () => {
  it('confirms via the explicit confirm button', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { getByTestId } = render(
      <ConfirmDialog
        visible
        title="Close this incident?"
        message="Closing locks the incident."
        confirmLabel="Confirm"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
        testID="dialog"
      />,
    );
    fireEvent.press(getByTestId('dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels without side effects', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { getByText } = render(
      <ConfirmDialog visible title="Reopen?" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.press(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders child inputs (reason/note fields)', () => {
    const { getByText } = render(
      <ConfirmDialog visible title="Reason" onConfirm={() => {}} onCancel={() => {}}>
        <TextField label="Reason (required)" value="" onChangeText={() => {}} />
      </ConfirmDialog>,
    );
    expect(getByText('Reason (required)')).toBeTruthy();
  });
});

describe('small pieces', () => {
  it('StatTile shows an em-dash for unknown counts (no fake zeros)', () => {
    const { getByText } = render(<StatTile label="Open" count={null} />);
    expect(getByText('—')).toBeTruthy();
  });

  it('Card renders children', () => {
    const { getByText } = render(<Card><Text>hello</Text></Card>);
    expect(getByText('hello')).toBeTruthy();
  });

  it('Chip renders its label', () => {
    const { getByText } = render(<Chip label="E-104" tone="error" />);
    expect(getByText('E-104')).toBeTruthy();
  });
});
