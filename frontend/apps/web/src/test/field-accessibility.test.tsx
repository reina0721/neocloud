import { SelectField, RadioGroupField } from '@neocloud/ui-adapter/form-field';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

it('选择框把提示和更新后的错误关联到真实控件', () => {
  const { rerender } = render(
    <SelectField
      label="存储位置"
      hint="选择可写目录"
      options={[]}
      value=""
      onValueChange={() => undefined}
    />,
  );
  expect(screen.getByRole('combobox', { name: '存储位置' })).toHaveAccessibleDescription(
    '选择可写目录',
  );
  rerender(
    <SelectField
      label="存储位置"
      error="目录已只读"
      options={[]}
      value=""
      onValueChange={() => undefined}
    />,
  );
  expect(screen.getByRole('combobox', { name: '存储位置' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(screen.getByRole('combobox', { name: '存储位置' })).toHaveAccessibleDescription(
    '目录已只读',
  );
  expect(screen.getByRole('alert')).toHaveTextContent('目录已只读');
});

it('单选组保留隐藏标题与组合提示错误的可访问语义', () => {
  render(
    <RadioGroupField
      label="主题"
      labelVisibility="screen-reader"
      hint="适用于整个工作区"
      error="保存失败，请重试"
      options={[{ value: 'light', label: '浅色' }]}
      value="light"
      onValueChange={() => undefined}
    />,
  );
  const group = screen.getByRole('radiogroup', { name: '主题' });
  expect(group).toHaveAttribute('aria-invalid', 'true');
  expect(group).toHaveAccessibleDescription('适用于整个工作区 保存失败，请重试');
  expect(screen.getByRole('radio', { name: '浅色' })).toBeChecked();
});
