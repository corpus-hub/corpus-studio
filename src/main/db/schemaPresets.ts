// The catalogue of premade extraction schemas, and the portable form they share
// with sharing and importing.
//
// WHY THESE ARE NOT SEEDED. A fresh install starts empty (CLAUDE.md), and these
// are field-specific shapes: a pharmacologist has no use for a photovoltaic
// schema sitting in their sidebar, and an app that arrives with seven opinions
// about other people's disciplines is claiming a domain it does not have. So a
// preset is a TEMPLATE the user instantiates — nothing exists in the DB until
// they pick one, and from that moment it is an ordinary user schema they can
// rename, extend and delete like any other.
//
// WHY THIS IS NOT SAMPLE DATA EITHER. The seed-only-DB rule exists so no screen
// renders domain facts that did not come from SQLite. A preset carries no facts:
// it is a blank form — labels, units and extraction hints with no measurement,
// no work and no paper behind it. What the user picks becomes real rows through
// the ordinary `createSchema`/`addSchemaField` path, so the schema they end up
// with is byte-identical to one they typed by hand, hash and all.
//
// WHY PRESETS AND THE SHARE PAYLOAD ARE ONE TYPE. A preset is a schema
// definition that came from us; a shared schema is one that came from a
// colleague. Nothing about instantiating them differs, so they are the same
// `SchemaBundle` and travel the same import path — which means the presets are
// exercised by every import test and a divergence between the two is not
// expressible.

import type {
  ExtractionFieldType,
  SchemaBundleFieldDTO,
  SchemaPresetDTO
} from '@shared/contract'

/**
 * The bundle format these presets declare, and the one `exportSchemaBundle`
 * stamps. A plain integer rather than a semver string because the only question
 * a reader of a pasted bundle can act on is "can this app read it". Bump it
 * when a change would make an older app MISREAD a newer bundle; an additive
 * optional field does not need one.
 */
export const SCHEMA_BUNDLE_FORMAT = 1

const f = (
  key: string,
  label: string,
  data_type: ExtractionFieldType,
  unit: string | null,
  required: boolean,
  description: string,
  enum_options: string[] | null = null
): SchemaBundleFieldDTO => ({ key, label, data_type, unit, required, enum_options, description })

/**
 * The catalogue.
 *
 * Chosen so each is a different SHAPE, not a different vocabulary for the same
 * one — a binding curve, a trial arm, a device I-V sweep, a reactor run, an
 * association statistic and a benchmark row have genuinely different columns,
 * different units and different things that make two rows incomparable.
 *
 * None of them re-declares fold-improvement or comparability: those stay
 * first-class in `fold_improvement` with its 4-enum, so there is exactly one
 * source of truth for whether two numbers may be compared.
 *
 * Every `description` DECLARES WHAT THE FIELD IS — what quantity it holds, on
 * what basis, and what distinguishes it from its neighbours. It is never an
 * instruction to the model, even though the string does reach the model
 * (`prompts.ts` builds the extraction target from it). A schema that also tells
 * the model how to behave puts extraction policy in as many places as there are
 * fields, where it cannot be reviewed, versioned or applied consistently: one
 * such line told the model to mark an implied temperature as assumed, and the
 * corpus filled with temperatures no paper printed. Behaviour belongs in
 * `prompts.ts`, which is versioned and stamped onto every run.
 */
export const SCHEMA_PRESETS: SchemaPresetDTO[] = [
  {
    id: 'enzyme-kinetics',
    discipline: 'Biochemistry',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Enzyme Kinetics',
      description:
        'Steady-state kinetic characterization of an enzyme variant under stated assay conditions.',
      fields: [
        f('variant', 'Variant', 'text', null, true,
          'Name or identifier of the enzyme variant the kinetics belong to.'),
        f('mutations', 'Mutations', 'text', null, false,
          'Substitutions carried by this variant relative to the stated parent, comma separated.'),
        f('substrate', 'Substrate', 'text', null, false, 'Substrate assayed.'),
        f('kcat', 'kcat', 'number', 's^-1', false,
          'Turnover number from a steady-state fit.'),
        f('km', 'KM', 'number', 'mM', false,
          'Michaelis constant.'),
        f('kcat_km', 'kcat/KM', 'number', 'M^-1 s^-1', false,
          'Catalytic efficiency, as reported rather than recomputed from kcat and KM.'),
        f('kcat_kuncat', 'kcat/kuncat', 'number', null, false,
          'Rate enhancement over the uncatalyzed reaction; dimensionless.'),
        f('temperature', 'Temperature', 'number', 'C', false,
          'Assay temperature in degrees Celsius.'),
        f('ph', 'pH', 'number', null, false, 'Assay pH.'),
        f('buffer', 'Buffer', 'text', null, false,
          'Buffer composition and concentration used for the assay.'),
        f('evolution_round', 'Evolution round', 'number', null, false,
          'Directed-evolution round or generation this variant came from, when the paper reports a trajectory.')
      ]
    }
  },
  {
    id: 'enzymeml',
    discipline: 'Biochemistry',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      // The EnzymeML data model's core reaction record: the reaction, the
      // catalyst, the species and the conditions a rate was measured under.
      // DISTINCT from Enzyme Kinetics above, which describes one variant's
      // constants — this describes one measured REACTION, which is the unit
      // EnzymeML interchanges and the level at which two labs' numbers can be
      // put in the same table at all.
      name: 'EnzymeML Reaction',
      description:
        'A single measured enzyme-catalysed reaction: catalyst, species, initial conditions and the observed rate, in the terms the EnzymeML data model records them.',
      fields: [
        f('reaction', 'Reaction', 'text', null, true,
          'The catalysed reaction, named as the paper names it.'),
        f('protein', 'Protein', 'text', null, true,
          'Catalysing protein or enzyme variant, with its identifier where one is given (UniProt accession, construct name).'),
        f('ec_number', 'EC number', 'text', null, false,
          'Enzyme Commission number.'),
        f('substrate', 'Substrate', 'text', null, false,
          'Reactant consumed, with its identifier (ChEBI, SMILES, InChI) where the paper gives one.'),
        f('product', 'Product', 'text', null, false, 'Species formed.'),
        f('init_substrate_conc', 'Initial [S]', 'number', 'mM', false,
          'Initial substrate concentration for this measurement.'),
        f('enzyme_conc', 'Enzyme concentration', 'number', 'uM', false,
          'Catalyst concentration in the assay.'),
        f('initial_rate', 'Initial rate', 'number', 'umol/min/mg', false,
          'Observed initial reaction rate or specific activity, exactly as reported.'),
        f('temperature', 'Temperature', 'number', 'C', false, 'Reaction temperature.'),
        f('ph', 'pH', 'number', null, false, 'Reaction pH.'),
        f('buffer', 'Buffer', 'text', null, false, 'Buffer composition and concentration.'),
        f('vessel', 'Vessel', 'text', null, false,
          'Reaction vessel and volume (cuvette, microplate well, stirred tank), where stated.'),
        f('measurement_type', 'Measured by', 'text', null, false,
          'How the reaction was followed.')
      ]
    }
  },
  {
    id: 'protein-thermostability',
    discipline: 'Biochemistry',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Protein Thermostability',
      description:
        'Thermal tolerance of a protein variant: melting and inactivation temperatures, unfolding free-energy change and residual-activity half-life, with the biophysical method used.',
      fields: [
        f('variant', 'Variant', 'text', null, true,
          'Protein variant whose thermal stability is being characterized.'),
        f('tm', 'Tm', 'number', 'C', false, 'Midpoint melting temperature in degrees Celsius.'),
        f('t50', 'T50', 'number', 'C', false,
          'Temperature at which half of the initial activity is lost after a fixed incubation.'),
        f('ddg', 'ddG', 'number', 'kcal/mol', false,
          'Change in unfolding free energy relative to the stated reference variant, signed as reported.'),
        f('half_life', 'Half-life', 'number', 'min', false,
          'Residual-activity half-life at the incubation temperature recorded in half_life_temp.'),
        f('half_life_temp', 'Half-life temperature', 'number', 'C', false,
          'Incubation temperature the half-life was measured at.'),
        f('method', 'Method', 'text', null, false,
          'Biophysical method the measurement was made with.'),
        f('buffer_ph', 'Buffer pH', 'number', null, false,
          'pH the stability measurement was performed at.'),
        f('reference_variant', 'Reference variant', 'text', null, false,
          'The variant this measurement is compared against (parent, wild type, or original design).')
      ]
    }
  },
  {
    id: 'binding-affinity',
    discipline: 'Pharmacology',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Binding Affinity & Inhibition',
      description:
        'Strength of a ligand–target interaction: dissociation and inhibition constants and half-maximal concentrations, with the assay that produced them.',
      fields: [
        f('ligand', 'Ligand', 'text', null, true,
          'Compound, peptide or biologic whose affinity is reported, under the paper\u2019s own identifier.'),
        f('target', 'Target', 'text', null, true,
          'Protein, receptor or nucleic acid bound, with species where stated.'),
        f('kd', 'Kd', 'number', 'nM', false,
          'Equilibrium dissociation constant, on its own scale rather than converted from a pKd.'),
        f('ki', 'Ki', 'number', 'nM', false, 'Inhibition constant.'),
        f('ic50', 'IC50', 'number', 'nM', false,
          'Half-maximal inhibitory concentration. Assay-dependent, and not a Ki.'),
        f('ec50', 'EC50', 'number', 'nM', false, 'Half-maximal effective concentration.'),
        f('assay', 'Assay', 'text', null, false,
          'Technique the constant was measured with.'),
        f('temperature', 'Temperature', 'number', 'C', false, 'Assay temperature.'),
        f('buffer_ph', 'Buffer pH', 'number', null, false, 'pH the binding was measured at.'),
        f('hill_slope', 'Hill slope', 'number', null, false,
          'Hill coefficient of the fitted curve, where reported.'),
        f('reference_compound', 'Reference compound', 'text', null, false,
          'Compound this one is compared against in the same assay.')
      ]
    }
  },
  {
    id: 'clinical-outcome',
    discipline: 'Medicine',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Clinical Trial Outcome',
      description:
        'One reported outcome of a clinical study: population, intervention, comparator and the effect estimate with its interval.',
      fields: [
        f('population', 'Population', 'text', null, true,
          'Who was studied: condition, setting and key eligibility criteria.'),
        f('intervention', 'Intervention', 'text', null, true,
          'Treatment received by the index arm, including dose and schedule where given.'),
        f('comparator', 'Comparator', 'text', null, false,
          'What the intervention was compared against (placebo, active control, standard of care).'),
        f('n_intervention', 'N (intervention)', 'number', null, false,
          'Participants analysed in the intervention arm for this outcome, not the enrolled total.'),
        f('n_comparator', 'N (comparator)', 'number', null, false,
          'Participants analysed in the comparator arm for this outcome.'),
        f('outcome', 'Outcome', 'text', null, true,
          'The endpoint being measured, as the paper defines it.'),
        f('effect_type', 'Effect measure', 'text', null, false,
          'Which statistic the effect value is. These are not interconvertible.'),
        f('effect_value', 'Effect', 'number', null, false,
          'The point estimate, exactly as reported.'),
        f('ci_low', 'CI lower', 'number', null, false, 'Lower bound of the confidence interval.'),
        f('ci_high', 'CI upper', 'number', null, false, 'Upper bound of the confidence interval.'),
        f('p_value', 'p', 'number', null, false,
          'Reported p-value.'),
        f('follow_up', 'Follow-up', 'number', 'months', false,
          'Duration of follow-up this outcome was measured over.'),
        f('design', 'Design', 'text', null, false, 'Study design.'),
        f('blinding', 'Blinding', 'text', null, false, 'Level of masking.')
      ]
    }
  },
  {
    id: 'variant-association',
    discipline: 'Genomics',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Genetic Variant Association',
      description:
        'An association between a genetic variant and a trait: effect allele, effect size and the sample it was estimated in.',
      fields: [
        f('variant', 'Variant', 'text', null, true,
          'Variant identifier as reported \u2014 rsID, or HGVS, or chromosome:position:ref:alt.'),
        f('gene', 'Gene', 'text', null, false,
          'Gene the variant is assigned to, where the paper assigns one.'),
        f('trait', 'Trait', 'text', null, true, 'Phenotype or trait tested.'),
        f('effect_allele', 'Effect allele', 'text', null, false,
          'The allele the effect size refers to. Without it the sign of the effect is meaningless.'),
        f('allele_frequency', 'Allele frequency', 'number', null, false,
          'Frequency of the effect allele in the study sample.'),
        f('effect_type', 'Effect measure', 'text', null, false,
          'Which statistic the effect value is.'),
        f('effect_value', 'Effect', 'number', null, false, 'Point estimate, exactly as reported.'),
        f('std_error', 'SE', 'number', null, false, 'Standard error of the effect estimate.'),
        f('p_value', 'p', 'number', null, false,
          'Association p-value, on its reported exponent scale (5e-8).'),
        f('sample_size', 'N', 'number', null, false,
          'Sample size this estimate came from. For case-control, the total unless the paper separates them.'),
        f('ancestry', 'Ancestry', 'text', null, false,
          'Ancestry or population of the sample, as the paper describes it.'),
        f('study_type', 'Study type', 'text', null, false, 'How the association was discovered.')
      ]
    }
  },
  {
    id: 'photovoltaic-device',
    discipline: 'Materials science',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Photovoltaic Device Performance',
      description:
        'Current–voltage performance of one solar cell: efficiency and its components, the illumination it was measured under, and its operational stability.',
      fields: [
        f('absorber', 'Absorber', 'text', null, true,
          'Active light-absorbing material and its composition, as written in the paper.'),
        f('architecture', 'Architecture', 'text', null, false,
          'Full device stack, layer by layer, where the paper gives it.'),
        f('pce', 'PCE', 'number', '%', false,
          'Power conversion efficiency. A champion cell and an average over a batch are different figures.'),
        f('jsc', 'Jsc', 'number', 'mA/cm^2', false, 'Short-circuit current density.'),
        f('voc', 'Voc', 'number', 'V', false, 'Open-circuit voltage.'),
        f('fill_factor', 'Fill factor', 'number', '%', false, 'Fill factor.'),
        f('active_area', 'Active area', 'number', 'cm^2', false,
          'Device active area. Efficiencies from very different areas are not comparable.'),
        f('illumination', 'Illumination', 'text', null, false,
          'Spectrum the measurement was taken under.'),
        f('certified', 'Certified', 'boolean', null, false,
          'Whether the efficiency was independently certified.'),
        f('t80_stability', 'T80', 'number', 'h', false,
          'Time to retain 80% of initial efficiency, where an operational stability test is reported.'),
        f('stability_conditions', 'Stability conditions', 'text', null, false,
          'Conditions of the stability test: atmosphere, temperature, illumination, bias, encapsulation.')
      ]
    }
  },
  {
    id: 'heterogeneous-catalysis',
    discipline: 'Chemical engineering',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Heterogeneous Catalysis Performance',
      description:
        'Performance of a solid catalyst on one reaction: conversion, selectivity and turnover under stated reactor conditions.',
      fields: [
        f('catalyst', 'Catalyst', 'text', null, true,
          'Active phase and loading, as the paper names it.'),
        f('support', 'Support', 'text', null, false, 'Support material, where the catalyst is supported.'),
        f('reaction', 'Reaction', 'text', null, true, 'Reaction catalysed.'),
        f('conversion', 'Conversion', 'number', '%', false,
          'Conversion of the limiting reactant.'),
        f('selectivity', 'Selectivity', 'number', '%', false,
          'Selectivity toward the target product.'),
        f('yield', 'Yield', 'number', '%', false,
          'Yield of the target product, as reported rather than conversion times selectivity.'),
        f('tof', 'TOF', 'number', 'h^-1', false,
          'Turnover frequency, on the basis the paper states (per metal atom, per site).'),
        f('temperature', 'Temperature', 'number', 'C', false, 'Reaction temperature.'),
        f('pressure', 'Pressure', 'number', 'bar', false, 'Total reaction pressure.'),
        f('space_velocity', 'Space velocity', 'number', 'h^-1', false,
          'Space velocity on the paper\u2019s own basis \u2014 GHSV, WHSV or LHSV.'),
        f('time_on_stream', 'Time on stream', 'number', 'h', false,
          'How long the catalyst had run when this measurement was taken. A conversion at 1 h and at 100 h are different claims.'),
        f('reactor', 'Reactor', 'text', null, false, 'Reactor configuration.')
      ]
    }
  },
  {
    id: 'ml-benchmark',
    discipline: 'Computer science',
    bundle: {
      format: SCHEMA_BUNDLE_FORMAT,
      name: 'Machine Learning Benchmark',
      description:
        'One reported model result on one benchmark: the metric, the split it was measured on, and the compute behind it.',
      fields: [
        f('model', 'Model', 'text', null, true, 'Model or system evaluated, at the version reported.'),
        f('parameters', 'Parameters', 'number', 'M', false,
          'Trainable parameter count in millions; active parameters for a mixture-of-experts model.'),
        f('dataset', 'Dataset', 'text', null, true, 'Benchmark or dataset evaluated on.'),
        f('task', 'Task', 'text', null, false, 'What the model was asked to do.'),
        f('metric', 'Metric', 'text', null, false, 'Which score the metric value is.'),
        f('metric_value', 'Score', 'number', null, false, 'The score, exactly as reported.'),
        f('split', 'Split', 'text', null, false,
          'Which data the score was measured on. A validation score and a test score are not comparable.'),
        f('pretraining_data', 'Pretraining data', 'text', null, false,
          'Corpus the model was pretrained on, where stated.'),
        f('compute', 'Compute', 'number', 'GPU-hours', false,
          'Training compute in GPU-hours, which differ by device.'),
        f('baseline', 'Baseline', 'text', null, false,
          'The model this result is compared against in the same table.')
      ]
    }
  }
]
