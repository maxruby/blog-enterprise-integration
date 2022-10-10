/* eslint-disable import/prefer-default-export */
/* eslint-disable no-console */
import { getTestPropsAsync } from '@andybalham/cdk-cloud-test-kit/testFunctionLib';
import { EventBridgeEvent } from 'aws-lambda';
import { DocumentClient } from 'aws-sdk/clients/dynamodb';
import {
  LenderRateRequested,
  LenderRateReceived,
  EventDomain,
  EventService,
  EventDetailType,
} from '../../src/domain/domain-events';
import { LenderQuote } from '../../src/domain/domain-models';
import {
  APPLICATION_EVENT_BUS_NAME,
  DATA_BUCKET_NAME,
} from '../../src/lender-gateway/constants';
import { getDataUrlAsync, putDomainEventAsync } from '../../src/lib/utils';

const eventBusName = process.env[APPLICATION_EVENT_BUS_NAME];
const dataBucketName = process.env[DATA_BUCKET_NAME];

const documentClient = new DocumentClient();

export interface MockLenderResponse {
  resultType: 'SUCCEEDED' | 'FAILED';
  lenderQuote?: LenderQuote;
}

export const handler = async (
  event: EventBridgeEvent<'RateRequested', LenderRateRequested>
): Promise<void> => {
  console.log(JSON.stringify({ event }, null, 2));

  const testProps = await getTestPropsAsync(documentClient);

  console.log(JSON.stringify({ testProps }, null, 2));

  const { lenderId } = event.detail.data.request;

  const lenderResponse: MockLenderResponse | undefined = testProps.inputs
    ?.lenderResponses
    ? testProps.inputs.lenderResponses[lenderId]
    : undefined;

  if (!lenderResponse) {
    return;
  }

  let rateDataUrl: string | undefined;
  if (lenderResponse.resultType === 'SUCCEEDED') {
    const { quoteReference } = event.detail.data.request;

    rateDataUrl = await getDataUrlAsync({
      bucketName: dataBucketName,
      key: `${quoteReference}/${quoteReference}-quote-${lenderId}.json`,
      data: JSON.stringify(lenderResponse.lenderQuote),
    });
  }

  const rateReceived: LenderRateReceived = {
    metadata: {
      domain: EventDomain.LoanBroker,
      service: EventService.LenderGateway,
      correlationId: event.detail.metadata.correlationId,
      requestId: event.detail.metadata.requestId,
    },
    data: {
      response: {
        lenderId,
        lenderQuoteDataUrl: rateDataUrl,
      },
      resultType: lenderResponse.resultType,
      taskToken: event.detail.data.taskToken,
    },
  };

  await putDomainEventAsync({
    eventBusName,
    detailType: EventDetailType.CreditReportReceived,
    event: rateReceived,
  });
};
