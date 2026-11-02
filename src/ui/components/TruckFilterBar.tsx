// Filter controls for the fleet view (bonus): status, fuel, region, route. The filter state lives in App, so the
// truck list (hides rows) and the map (dims markers) use the same filter.
import type { ChangeEvent, ReactElement } from 'react';
import { TruckStatusSchema } from '../../domain/models';
import { REGION_LABELS, REGIONS } from '../../domain/regions';
import { isFiltering, NO_FILTER, type TruckFilter } from '../truckFilter';

interface Option {
  value: string;
  label: string;
}

const STATUS_OPTIONS: Option[] = [
  { value: 'all', label: 'Any status' },
  ...TruckStatusSchema.options.map((status) => ({ value: status, label: status })),
];
const FUEL_OPTIONS: Option[] = [
  { value: 'all', label: 'Any fuel' },
  { value: 'low', label: 'Low fuel' },
  { value: 'under-half', label: 'Under 50%' },
];
const REGION_OPTIONS: Option[] = [
  { value: 'all', label: 'Any region' },
  ...REGIONS.map((region) => ({ value: region, label: REGION_LABELS[region] })),
];
const ROUTE_OPTIONS: Option[] = [
  { value: 'all', label: 'Any route' },
  { value: 'assigned', label: 'Has a route' },
  { value: 'unassigned', label: 'No route' },
];

interface SelectProps {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}

function FilterSelect({ label, value, options, onChange }: SelectProps): ReactElement {
  return (
    <select aria-label={label} value={value} onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface Props {
  filter: TruckFilter;
  onChange: (filter: TruckFilter) => void;
}

// Values come only from our own <option> lists, so casting the select's string back to the field type is safe.
export function TruckFilterBar({ filter, onChange }: Props): ReactElement {
  return (
    <div className="filter-bar">
      <FilterSelect
        label="Filter by status"
        value={filter.status}
        options={STATUS_OPTIONS}
        onChange={(value) => onChange({ ...filter, status: value as TruckFilter['status'] })}
      />
      <FilterSelect
        label="Filter by fuel"
        value={filter.fuel}
        options={FUEL_OPTIONS}
        onChange={(value) => onChange({ ...filter, fuel: value as TruckFilter['fuel'] })}
      />
      <FilterSelect
        label="Filter by region"
        value={filter.region}
        options={REGION_OPTIONS}
        onChange={(value) => onChange({ ...filter, region: value as TruckFilter['region'] })}
      />
      <FilterSelect
        label="Filter by route"
        value={filter.route}
        options={ROUTE_OPTIONS}
        onChange={(value) => onChange({ ...filter, route: value as TruckFilter['route'] })}
      />
      <button onClick={() => onChange(NO_FILTER)} disabled={!isFiltering(filter)}>
        Clear
      </button>
    </div>
  );
}
