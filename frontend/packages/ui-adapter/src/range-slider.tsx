'use client';
import Slider from '@mui/material/Slider';
type RangeSliderProps = Readonly<{
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onValueChange: (value: number) => void;
}>;

/** RangeSlider 为已在相邻区域显示数值的单轴控制提供键盘和指针交互。 */

export function RangeSlider({
  label,
  value,
  min = 0,
  max,
  step = 1,
  disabled = false,
  onValueChange,
}: RangeSliderProps) {
  return (
    <Slider
      className="ui-range-slider"
      aria-label={label}
      slotProps={{
        track: { className: 'ui-slider-track' },
        thumb: { className: 'ui-slider-thumb' },
      }}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(_, next) => {
        if (typeof next === 'number') onValueChange(next);
      }}
    />
  );
}
