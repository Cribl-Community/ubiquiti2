import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InvestigatorChat } from '@criblio/app-utils/investigator';
import MetricsToolCard from '@criblio/app-utils/investigator/metrics-tool-card';
import type { MetricsQueryUi } from '@criblio/app-utils/agent-tools';
import {
  buildContext,
  buildSeedPrompt,
  executeToolCall,
  toolDefinitions,
  SUGGESTED_QUESTIONS,
} from '../api/investigator';

/** Optional ?q= deep link — pre-fires an investigation from the URL. */
export default function InvestigatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const seed = useMemo(() => {
    const state = location.state as { question?: string } | null;
    if (state?.question) return { question: state.question };
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    return q ? { question: q } : undefined;
  }, [location.state, location.search]);

  return (
    <InvestigatorChat
      title="Network Investigator"
      subtitle="AI-assisted investigation over UniFi metrics and logs"
      emptyStateTitle="Investigate your network"
      emptyStateHint="Ask about clients, APs, switches, WAN health, or anything the network did — or start from one of these:"
      emptyStateSuggestions={SUGGESTED_QUESTIONS}
      buildSeedPrompt={buildSeedPrompt}
      toolDefinitions={toolDefinitions}
      buildContext={buildContext}
      executeToolCall={executeToolCall}
      seed={seed}
      onSeedConsumed={() => navigate('/investigate', { replace: true })}
      renderToolCard={(ui) =>
        ui.kind === 'metrics' ? <MetricsToolCard ui={ui as MetricsQueryUi} /> : null
      }
    />
  );
}
