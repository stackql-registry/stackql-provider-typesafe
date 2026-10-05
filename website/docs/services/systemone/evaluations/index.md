--- 
title: evaluations
hide_title: false
hide_table_of_contents: false
keywords:
  - evaluations
  - systemone
  - typesafe
  - infrastructure-as-code
  - configuration-as-data
  - cloud inventory
description: Query, deploy and manage typesafe resources using SQL
custom_edit_url: null
image: /img/stackql-typesafe-provider-featured-image.png
---

import CopyableCode from '@site/src/components/CopyableCode/CopyableCode';
import CodeBlock from '@theme/CodeBlock';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

Creates, updates, deletes, gets or lists an <code>evaluations</code> resource.

## Overview
<table><tbody>
<tr><td><b>Name</b></td><td><CopyableCode code="evaluations" /></td></tr>
<tr><td><b>Type</b></td><td>Resource</td></tr>
<tr><td><b>Id</b></td><td><CopyableCode code="typesafe.systemone.evaluations" /></td></tr>
</tbody></table>

## Fields

The following fields are returned by `SELECT` queries:

<Tabs
    defaultValue="evaluate"
    values={[
        { label: 'evaluate', value: 'evaluate' }
    ]}
>
<TabItem value="evaluate">

<table>
<thead>
    <tr>
    <th>Name</th>
    <th>Datatype</th>
    <th>Description</th>
    </tr>
</thead>
<tbody>
<tr>
    <td><CopyableCode code="answers" /></td>
    <td><code>object</code></td>
    <td>Answers keyed by the question names supplied in the request. Each answer's type matches its question's type. (title: Answers)</td>
</tr>
<tr>
    <td><CopyableCode code="model" /></td>
    <td><code>string</code></td>
    <td>Name of the model that answered the questions. May differ from the alias supplied in the request. (title: Model)</td>
</tr>
<tr>
    <td><CopyableCode code="usage" /></td>
    <td><code>object</code></td>
    <td>Input and output token counts for this evaluation. (title: Usage)</td>
</tr>
</tbody>
</table>
</TabItem>
</Tabs>

## Methods

The following methods are available for this resource:

<table>
<thead>
    <tr>
    <th>Name</th>
    <th>Accessible by</th>
    <th>Required Params</th>
    <th>Optional Params</th>
    <th>Description</th>
    </tr>
</thead>
<tbody>
<tr>
    <td><a href="#evaluate"><CopyableCode code="evaluate" /></a></td>
    <td><CopyableCode code="select" /></td>
    <td><a href="#parameter-model"><code>model</code></a>, <a href="#parameter-questions"><code>questions</code></a>, <a href="#parameter-state"><code>state</code></a></td>
    <td></td>
    <td>Answer one or more questions about the content supplied in `state`.<br /><br />You can mix question types in one request. Answers use the same names as the<br />questions, so you can match each result to its question. The response also includes<br />the model used and token usage.</td>
</tr>
</tbody>
</table>

## Parameters

Parameters can be passed in the `WHERE` clause of a query. Check the [Methods](#methods) section to see which parameters are required or optional for each operation.

<table>
<thead>
    <tr>
    <th>Name</th>
    <th>Datatype</th>
    <th>Description</th>
    </tr>
</thead>
<tbody>
<tr id="parameter-model">
    <td><CopyableCode code="model" /></td>
    <td><code>string</code></td>
    <td>Name or alias of the model to use. Available names are returned by GET /v1/models.</td>
</tr>
<tr id="parameter-questions">
    <td><CopyableCode code="questions" /></td>
    <td><code>object</code></td>
    <td>Questions to ask about the content, each with a name you choose. The response uses those names to identify the answers.</td>
</tr>
<tr id="parameter-state">
    <td><CopyableCode code="state" /></td>
    <td><code>string</code></td>
    <td>The content all questions in this request refer to.</td>
</tr>
</tbody>
</table>

## `SELECT` examples

<Tabs
    defaultValue="evaluate"
    values={[
        { label: 'evaluate', value: 'evaluate' }
    ]}
>
<TabItem value="evaluate">

Answer one or more questions about the content supplied in `state`.<br /><br />You can mix question types in one request. Answers use the same names as the<br />questions, so you can match each result to its question. The response also includes<br />the model used and token usage.

```sql
SELECT
answers,
model,
usage
FROM typesafe.systemone.evaluations
WHERE model = '{{ model }}' -- required
AND questions = '{{ questions }}' -- required
AND state = '{{ state }}' -- required
;
```
</TabItem>
</Tabs>
