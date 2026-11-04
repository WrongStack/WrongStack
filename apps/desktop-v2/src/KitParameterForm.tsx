import { Plus, X } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { record } from './engine-values';
import { type KitSchema, kitInitialValue, kitValuesEqual } from './project-kit-model';

export function KitParameterForm({
  schema,
  value,
  onChange,
  path: given,
}: {
  schema: KitSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  path?: string;
}) {
  const { t } = useDesktopText();
  const path = given ?? t('projectKit.input');
  if (schema.enum?.length)
    return (
      <div className="kit-field">
        <label>
          {path}
          <small>{schema.description}</small>
          <select
            aria-label={path}
            value={schema.enum.findIndex((v) => kitValuesEqual(v, value))}
            onChange={(e) => onChange(structuredClone(schema.enum?.[Number(e.target.value)]))}
          >
            {schema.enum.map((item, i) => (
              <option key={i} value={i}>
                {typeof item === 'object' ? t('kitForm.option', { number: i + 1 }) : String(item)}
              </option>
            ))}
          </select>
        </label>
        {typeof value === 'object' && <KitValue value={value} />}
      </div>
    );
  if (schema.type === 'object') {
    const object = record(value);
    return (
      <fieldset className="kit-parameters">
        <legend>{path}</legend>
        {schema.description && <p>{schema.description}</p>}
        {Object.entries(schema.properties ?? {}).map(([name, child]) => {
          const required = schema.required?.includes(name) ?? false;
          const included = Object.hasOwn(object, name);
          return (
            <div className="kit-property" key={name}>
              {!required && (
                <label className="kit-check">
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={(e) => {
                      const next = { ...object };
                      if (e.target.checked) next[name] = kitInitialValue(child);
                      else delete next[name];
                      onChange(next);
                    }}
                  />
                  {t('kitForm.include', { name })}
                </label>
              )}
              {(required || included) && (
                <KitParameterForm
                  schema={child}
                  value={object[name]}
                  path={`${path}.${name}`}
                  onChange={(next) => onChange({ ...object, [name]: next })}
                />
              )}
            </div>
          );
        })}
        {!Object.keys(schema.properties ?? {}).length && <p>{t('kitForm.noParameters')}</p>}
      </fieldset>
    );
  }
  if (schema.type === 'array') {
    const items = Array.isArray(value) ? value : [];
    return (
      <fieldset className="kit-parameters">
        <legend>{path}</legend>
        <p>{schema.description ?? t('kitForm.itemsHelp')}</p>
        {items.map((item, i) => (
          <div className="kit-array-item" key={i}>
            <KitParameterForm
              schema={schema.items as KitSchema}
              value={item}
              path={`${path}[${i + 1}]`}
              onChange={(next) => onChange(items.map((old, index) => (index === i ? next : old)))}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={t('kitForm.remove', { path: `${path}[${i + 1}]` })}
              onClick={() => onChange(items.filter((_, index) => index !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button secondary small"
          disabled={schema.maxItems !== undefined && items.length >= schema.maxItems}
          onClick={() => onChange([...items, kitInitialValue(schema.items as KitSchema)])}
        >
          <Plus size={13} />
          {t('kitForm.addItem', { path })}
        </button>
      </fieldset>
    );
  }
  if (schema.type === 'boolean')
    return (
      <label className="kit-check">
        <input
          aria-label={path}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {path}
          <small>{schema.description}</small>
        </span>
      </label>
    );
  if (schema.type === 'null')
    return (
      <p>
        {t('kitForm.emptyField', { path })} <small>{schema.description}</small>
      </p>
    );
  const numeric = schema.type === 'number' || schema.type === 'integer';
  return (
    <label className="kit-field">
      {path}
      <small>{schema.description}</small>
      <input
        aria-label={path}
        type={numeric ? 'number' : 'text'}
        step={schema.type === 'integer' ? 1 : 'any'}
        min={schema.minimum}
        max={schema.maximum}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        value={typeof value === 'number' && !Number.isFinite(value) ? '' : String(value ?? '')}
        onChange={(e) =>
          onChange(
            numeric
              ? e.target.value === ''
                ? Number.NaN
                : Number(e.target.value)
              : e.target.value,
          )
        }
      />
    </label>
  );
}

export function KitValue({ value }: { value: unknown }) {
  const { t } = useDesktopText();
  if (Array.isArray(value))
    return value.length ? (
      <ol className="kit-values">
        {value.map((item, i) => (
          <li key={i}>
            <KitValue value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="field-help">{t('kitForm.emptyList')}</span>
    );
  if (value && typeof value === 'object')
    return (
      <dl className="kit-values">
        {Object.entries(value).map(([name, item]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <KitValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span className="kit-value">
      {value === null
        ? t('kitForm.emptyValue')
        : typeof value === 'number' && !Number.isFinite(value)
          ? t('kitForm.notEntered')
          : value === true
            ? t('kitForm.yes')
            : value === false
              ? t('kitForm.no')
              : value === undefined
                ? t('kitForm.notSupplied')
                : String(value)}
    </span>
  );
}

export function KitSchemaDetails({ schema, name }: { schema: KitSchema; name?: string }) {
  const { t } = useDesktopText();
  return (
    <div className="kit-schema-row">
      <strong>{name ?? t('kitForm.result')}</strong>
      <span>
        {schema.type}
        {schema.required?.length
          ? ` · ${t('kitForm.required', { names: schema.required.join(', ') })}`
          : ''}
      </span>
      {schema.description && <p>{schema.description}</p>}
      {schema.minimum !== undefined && (
        <small>{t('kitForm.minimum', { value: schema.minimum })} </small>
      )}
      {schema.maximum !== undefined && (
        <small>{t('kitForm.maximum', { value: schema.maximum })} </small>
      )}
      {schema.minLength !== undefined && (
        <small>{t('kitForm.minLength', { value: schema.minLength })} </small>
      )}
      {schema.maxLength !== undefined && (
        <small>{t('kitForm.maxLength', { value: schema.maxLength })} </small>
      )}
      {schema.minItems !== undefined && (
        <small>{t('kitForm.minItems', { value: schema.minItems })} </small>
      )}
      {schema.maxItems !== undefined && (
        <small>{t('kitForm.maxItems', { value: schema.maxItems })} </small>
      )}
      {schema.enum && (
        <div>
          {t('kitForm.allowed')} <KitValue value={schema.enum} />
        </div>
      )}
      {Object.hasOwn(schema, 'default') && (
        <div>
          {t('kitForm.default')} <KitValue value={schema.default} />
        </div>
      )}
      {Object.entries(schema.properties ?? {}).map(([key, child]) => (
        <KitSchemaDetails key={key} schema={child} name={key} />
      ))}
      {schema.items && (
        <KitSchemaDetails schema={schema.items as KitSchema} name={t('kitForm.eachItem')} />
      )}
    </div>
  );
}
