import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton } from '@neocloud/ui-adapter/menu-button';
import { OverlayTriggerAction } from '@neocloud/ui-adapter/overlay-trigger';

describe('OverlayTriggerAction语义', () => {
  it('非受控菜单仍通知打开和关闭，按需读取菜单内容的业务可以订阅', () => {
    const changed = vi.fn();
    const action = vi.fn();
    render(
      <MenuButton
        label="新建"
        ariaLabel="新建"
        items={[{ id: 'folder', label: '文件夹' }]}
        onAction={action}
        onOpenChange={changed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    expect(changed).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('menuitem', { name: '文件夹' }));
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(action).toHaveBeenCalledWith('folder');
  });
  it('默认触发器保留名称与一次点击动作', () => {
    const pressed = vi.fn();
    render(<OverlayTriggerAction onPress={pressed}>打开</OverlayTriggerAction>);
    const button = screen.getByRole('button', { name: '打开' });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(pressed).toHaveBeenCalledOnce();
  });
  it('危险触发器仍使用相同语义契约', () => {
    const pressed = vi.fn();
    render(
      <OverlayTriggerAction tone="danger" onPress={pressed}>
        删除
      </OverlayTriggerAction>,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(pressed).toHaveBeenCalledOnce();
  });
  it('禁用的触发器不能执行动作', () => {
    const pressed = vi.fn();
    render(
      <OverlayTriggerAction disabled onPress={pressed}>
        触发
      </OverlayTriggerAction>,
    );
    const button = screen.getByRole('button', { name: '触发' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(pressed).not.toHaveBeenCalled();
  });
});
